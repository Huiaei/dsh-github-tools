/**
 * copilot.js — 3 tool handlers.
 *
 *   - assign_copilot_to_issue
 *   - request_copilot_review
 *   - assign_copilot_to_issue_with_intent
 *
 * Ported from pkg/github/copilot.go; the output projections mirror
 * pkg/github/typed_copilot_ui_outputs.go.
 *
 * `assign_copilot_to_issue` and `assign_copilot_to_issue_with_intent` are
 * GraphQL: both look up the `copilot-swe-agent` bot among the repository's
 * suggested actors, then run `updateIssue`. The assignment API is still
 * feature-flagged, so the mutation carries the `GraphQL-Features:
 * issues_copilot_assignment_api_support` header. After a real assignment the
 * upstream handler polls the issue timeline for the Copilot-authored pull
 * request (9 attempts, 1s apart) and reports it when it shows up.
 *
 * `request_copilot_review` is REST and always asks for the
 * `copilot-pull-request-reviewer[bot]` reviewer.
 */

import { fail, optionalString, seg, toPositiveInt } from '../util.js';

/** The bot that accepts the assignment; the login is the same on every host. */
const COPILOT_BOT_LOGIN = 'copilot-swe-agent';

/** The login name of the Copilot reviewer bot. */
const COPILOT_REVIEWER_LOGIN = 'copilot-pull-request-reviewer[bot]';

/** The agent-assignment GraphQL API is not GA yet, so it needs this header. */
const GRAPHQL_FEATURES = 'issues_copilot_assignment_api_support';

/** The e2e tests depend on this exact message to skip the test. */
const COPILOT_UNAVAILABLE_MESSAGE =
  "copilot isn't available as an assignee for this issue. Please inform the user to visit " +
  'https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent for more information.';

/** Reported when the assignment succeeded but the pull request has not appeared yet. */
const PULL_REQUEST_PENDING_NOTE =
  'The pull request may still be in progress. Once created, the PR number can be used to check job status, ' +
  'or check the issue timeline for updates.';

const MESSAGE_PR_CREATED = 'successfully assigned copilot to issue - pull request created';
const MESSAGE_PR_PENDING = 'successfully assigned copilot to issue - pull request pending';
const MESSAGE_SUGGESTION_RECORDED = 'recorded pending copilot assignment suggestion';

/** Upstream `getPollConfig` defaults: 9 attempts with a 1s delay (~8s max). */
const POLL_MAX_ATTEMPTS = 9;
const POLL_DELAY_MS = 1_000;

/** Upstream paginates `suggestedActors` until it finds the bot; this bounds the walk. */
const SUGGESTED_ACTORS_MAX_PAGES = 20;

const SUGGESTED_ACTORS_QUERY = `
query($owner: String!, $name: String!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    suggestedActors(first: 100, after: $endCursor, capabilities: CAN_BE_ASSIGNED) {
      nodes {
        ... on Bot {
          id
          login
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

const ISSUE_TARGET_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    id
    issue(number: $number) {
      id
      assignees(first: 100) {
        nodes {
          id
        }
      }
    }
  }
}`;

const TIMELINE_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(first: 20, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          __typename
          ... on CrossReferencedEvent {
            source {
              ... on PullRequest {
                number
                url
                title
                state
                createdAt
                author {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const UPDATE_ISSUE_MUTATION = `
mutation($input: UpdateIssueInput!) {
  updateIssue(input: $input) {
    issue {
      id
      number
      url
    }
  }
}`;

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Upstream guards reject a missing string argument with this exact wording. */
function requireParameter(args, name) {
  const value = optionalString(args, name);
  if (value === undefined) fail(`missing required parameter: ${name}`);
  return value;
}

/** `issue_number`/`pullNumber` are rejected the same way when absent or zero. */
function requireNumber(args, name) {
  const value = toPositiveInt(args?.[name], 0);
  if (value === 0) fail(`missing required parameter: ${name}`);
  return value;
}

/** `normalizeConfidence` — trim and upper-case before comparing. */
function normalizeConfidence(value) {
  return String(value ?? '').trim().toUpperCase();
}

/**
 * GraphQL call that can carry the extra `GraphQL-Features` header the
 * agent-assignment API requires (`ctx.client.graphql` cannot send headers).
 */
async function graphqlRequest(ctx, query, variables, features = undefined) {
  const { json } = await ctx.client.request('POST', ctx.client.graphqlUrl, {
    absolute: true,
    body: { query, variables },
    headers: {
      'content-type': 'application/json',
      ...(features === undefined ? {} : { 'GraphQL-Features': features }),
    },
    signal: ctx.signal,
  });
  if (Array.isArray(json?.errors) && json.errors.length > 0) {
    fail(json.errors.map((entry) => entry?.message ?? String(entry)).join('; '));
  }
  return json?.data ?? null;
}

/**
 * `findCopilotSuggestedActor` — walk `suggestedActors` looking for the Copilot
 * bot. Returns `null` (without an error) when it is not offered as an assignee.
 */
async function findCopilotSuggestedActor(ctx, owner, repo) {
  let endCursor = null;
  for (let page = 0; page < SUGGESTED_ACTORS_MAX_PAGES; page += 1) {
    const data = await graphqlRequest(ctx, SUGGESTED_ACTORS_QUERY, { owner, name: repo, endCursor });
    const connection = data?.repository?.suggestedActors;
    for (const node of connection?.nodes ?? []) {
      if (node?.login === COPILOT_BOT_LOGIN && node?.id != null) return { id: node.id, login: node.login };
    }
    if (connection?.pageInfo?.hasNextPage !== true) return null;
    endCursor = connection.pageInfo.endCursor;
  }
  return null;
}

/** `getIssueQuery` — the issue id, the repository id and the current assignees. */
async function fetchIssueTarget(ctx, owner, repo, issueNumber) {
  const data = await graphqlRequest(ctx, ISSUE_TARGET_QUERY, { owner, name: repo, number: issueNumber });
  const repository = data?.repository;
  const issue = repository?.issue;
  if (repository?.id == null || issue?.id == null) {
    fail(`issue #${issueNumber} not found in ${owner}/${repo}`);
  }
  return {
    repositoryId: repository.id,
    issueId: issue.id,
    assigneeIds: (issue.assignees?.nodes ?? []).map((node) => node.id),
  };
}

/**
 * `findLinkedCopilotPR` — the first cross-referenced PR authored by the Copilot
 * bot and created after the assignment.
 */
async function findLinkedCopilotPR(ctx, owner, repo, issueNumber, createdAfter) {
  const data = await graphqlRequest(ctx, TIMELINE_QUERY, { owner, name: repo, number: issueNumber });
  for (const node of data?.repository?.issue?.timelineItems?.nodes ?? []) {
    if (node?.__typename !== 'CrossReferencedEvent') continue;
    const pullRequest = node?.source?.pullRequest;
    if (pullRequest == null || typeof pullRequest.number !== 'number' || pullRequest.number <= 0) continue;
    if (pullRequest.author?.login !== COPILOT_BOT_LOGIN) continue;
    const createdAt = Date.parse(pullRequest.createdAt ?? '');
    if (!Number.isFinite(createdAt) || createdAt <= createdAfter.getTime()) continue;
    return {
      number: pullRequest.number,
      url: pullRequest.url,
      title: pullRequest.title,
      state: pullRequest.state,
    };
  }
  return null;
}

/**
 * Poll for the pull request Copilot opens for the assignment. Query failures are
 * non-fatal upstream (the next attempt just tries again), and an aborted call
 * stops the loop instead of burning the remaining attempts.
 */
async function pollForLinkedPullRequest(ctx, owner, repo, issueNumber, createdAfter) {
  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await sleep(POLL_DELAY_MS);
    if (ctx.signal?.aborted === true) return null;
    let pullRequest = null;
    try {
      pullRequest = await findLinkedCopilotPR(ctx, owner, repo, issueNumber, createdAfter);
    } catch {
      continue; // upstream swallows polling errors and retries
    }
    if (pullRequest !== null) return pullRequest;
  }
  return null;
}

/** The `agentAssignment` input shared by both assignment tools. */
function agentAssignmentInput(repositoryId, baseRef, customInstructions) {
  const input = { customAgent: '', customInstructions: '', targetRepositoryId: repositoryId };
  if (baseRef !== undefined) input.baseRef = baseRef;
  if (customInstructions !== undefined) input.customInstructions = customInstructions;
  return input;
}

/** `assign_copilot_to_issue` — GraphQL updateIssue with the legacy assignee ids. */
async function assignCopilotToIssue(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const issueNumber = requireNumber(args, 'issue_number');
  const baseRef = optionalString(args, 'base_ref');
  const customInstructions = optionalString(args, 'custom_instructions');

  const copilot = await findCopilotSuggestedActor(ctx, owner, repo);
  if (copilot === null) fail(COPILOT_UNAVAILABLE_MESSAGE);

  const target = await fetchIssueTarget(ctx, owner, repo, issueNumber);
  const assigneeIds = [...target.assigneeIds, copilot.id];

  const assignmentTime = new Date();
  const data = await graphqlRequest(
    ctx,
    UPDATE_ISSUE_MUTATION,
    {
      input: {
        id: target.issueId,
        assigneeIds,
        agentAssignment: agentAssignmentInput(target.repositoryId, baseRef, customInstructions),
      },
    },
    GRAPHQL_FEATURES,
  );

  const updated = data?.updateIssue?.issue ?? {};
  const pullRequest = await pollForLinkedPullRequest(ctx, owner, repo, issueNumber, assignmentTime);
  const result = {
    issue_number: updated.number,
    issue_url: updated.url,
    message: pullRequest === null ? MESSAGE_PR_PENDING : MESSAGE_PR_CREATED,
    owner,
    repo,
  };
  if (pullRequest === null) result.note = PULL_REQUEST_PENDING_NOTE;
  else result.pull_request = pullRequest;
  return result;
}

/** `request_copilot_review` — POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers. */
async function requestCopilotReview(args, ctx) {
  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const pullNumber = requireNumber(args, 'pullNumber');

  let status;
  try {
    const response = await ctx.client.request(
      'POST',
      `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}/requested_reviewers`,
      { body: { reviewers: [COPILOT_REVIEWER_LOGIN] }, signal: ctx.signal },
    );
    status = response.status;
  } catch (error) {
    const hint = await copilotReviewHint(ctx, owner, repo, pullNumber, error);
    if (hint === null) throw error;
    fail(hint);
  }
  if (status !== 201) fail(`failed to request copilot review: unexpected status ${status}`);
  // Upstream returns nothing on success, as the pull request itself adds no value.
  return { status: 'requested' };
}

/**
 * `copilotReviewErrMsg` — this endpoint answers a bare 404 when the caller
 * lacks write access, which is otherwise indistinguishable from a missing
 * repository or pull request, so the repository is read to tell them apart.
 * Returns `null` when the error should be passed through unchanged.
 */
async function copilotReviewHint(ctx, owner, repo, pullNumber, error) {
  const status = error?.status;
  if (status !== 404 && status !== 403) return null;
  // Rate limiting is reported as 403 too, and the read below would be refused
  // for the same reason, so leave the caller with the rate limit message.
  if (error?.rateLimitRemaining === '0') return null;

  const base = 'failed to request copilot review';
  let repository;
  try {
    repository = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}`, { signal: ctx.signal });
  } catch {
    return (
      `${base}. ${owner}/${repo} could not be read with the current credentials, so it may not exist or the ` +
      'credentials may not reach it. Lacking write access is refused with the same status.'
    );
  }
  if (repository?.permissions?.push !== true) {
    return (
      `${base}. The authenticated user has no write access to ${owner}/${repo}, and GitHub requires write access ` +
      'to request a reviewer, even from the author of the pull request. Request the Copilot review from the pull ' +
      'request page on the GitHub website instead, or ask someone with write access to request it.'
    );
  }
  return (
    `${base}. The authenticated user has write access to ${owner}/${repo}, so check that pull request #${pullNumber} ` +
    'exists there and that Copilot code review is available for the repository. Copilot code review is not ' +
    'available on GitHub Enterprise Server.'
  );
}

/**
 * `assign_copilot_to_issue_with_intent` — GraphQL updateIssue with the
 * object-form assignees that carry the intent metadata. A suggestion records
 * the intent without launching the agent; a direct assignment keeps the same
 * launch configuration and PR polling as `assign_copilot_to_issue`.
 */
async function assignCopilotToIssueWithIntent(args, ctx) {
  // Presence-check `is_suggestion` before anything else: defaulting a missing
  // boolean to false would silently launch Copilot instead of recording a
  // suggestion, so callers must make the choice explicit.
  if (!Object.hasOwn(args ?? {}, 'is_suggestion')) fail('is_suggestion is required');

  const owner = requireParameter(args, 'owner');
  const repo = requireParameter(args, 'repo');
  const issueNumber = requireNumber(args, 'issue_number');
  const baseRef = optionalString(args, 'base_ref');
  const customInstructions = optionalString(args, 'custom_instructions');

  const rationale = optionalString(args, 'rationale');
  if (rationale === undefined) fail('rationale is required');
  if ([...rationale].length > 280) fail('rationale must be 280 characters or less');

  const confidence = normalizeConfidence(args?.confidence);
  if (confidence === '') fail('confidence is required');
  if (confidence !== 'LOW' && confidence !== 'MEDIUM' && confidence !== 'HIGH') {
    fail('confidence must be one of: LOW, MEDIUM, HIGH');
  }

  const isSuggestion = args?.is_suggestion === true || args?.is_suggestion === 'true';

  const copilot = await findCopilotSuggestedActor(ctx, owner, repo);
  if (copilot === null) fail(COPILOT_UNAVAILABLE_MESSAGE);

  const target = await fetchIssueTarget(ctx, owner, repo, issueNumber);

  // Preserved assignees carry only `actorId`; an existing Copilot assignment is
  // skipped so its actor id is not sent twice (once without the intent).
  const assignees = target.assigneeIds
    .filter((actorId) => actorId !== copilot.id)
    .map((actorId) => ({ actorId }));
  assignees.push({ actorId: copilot.id, rationale, confidence, suggest: isSuggestion });

  const input = { id: target.issueId, assignees };
  if (!isSuggestion) {
    input.agentAssignment = agentAssignmentInput(target.repositoryId, baseRef, customInstructions);
  }

  const assignmentTime = new Date();
  const data = await graphqlRequest(ctx, UPDATE_ISSUE_MUTATION, { input }, GRAPHQL_FEATURES);
  const updated = data?.updateIssue?.issue ?? {};

  const result = {
    issue_number: updated.number,
    issue_url: updated.url,
    is_suggestion: isSuggestion,
    message: MESSAGE_SUGGESTION_RECORDED,
    owner,
    repo,
  };

  // A pure suggestion does not launch Copilot, so there is no pull request to wait for.
  if (isSuggestion) return result;

  const pullRequest = await pollForLinkedPullRequest(ctx, owner, repo, issueNumber, assignmentTime);
  if (pullRequest === null) {
    result.message = MESSAGE_PR_PENDING;
    result.note = PULL_REQUEST_PENDING_NOTE;
  } else {
    result.message = MESSAGE_PR_CREATED;
    result.pull_request = pullRequest;
  }
  return result;
}

export default {
  assign_copilot_to_issue: assignCopilotToIssue,
  request_copilot_review: requestCopilotReview,
  assign_copilot_to_issue_with_intent: assignCopilotToIssueWithIntent,
};

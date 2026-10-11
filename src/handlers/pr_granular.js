/**
 * Granular pull request handlers.
 *
 * Tools:
 *   - update_pull_request_title
 *   - update_pull_request_body
 *   - update_pull_request_state
 *   - update_pull_request_draft_state
 *   - request_pull_request_reviewers
 *   - create_pull_request_review
 *   - submit_pending_pull_request_review
 *   - delete_pending_pull_request_review
 *   - add_pull_request_review_comment
 *   - resolve_review_thread
 *   - unresolve_review_thread
 *   - add_pull_request_review_comment_reaction
 *   - remove_pull_request_review_comment_reaction
 *   - hide_pull_request_review_comment
 *   - unhide_pull_request_review_comment
 *   - hide_pull_request_review
 *   - unhide_pull_request_review
 *
 * Ported from the upstream Go server:
 *   pkg/github/pullrequests_granular.go (every tool except the hide/unhide pair)
 *   pkg/github/comment_minimize.go      (commentVisibilityTool: the hide/unhide pair)
 *   pkg/github/pullrequests.go          (the shared review-write and thread helpers)
 *   pkg/github/minimal_types.go         (MinimalResponse)
 *
 * The hide/unhide tools are four instances of the upstream `commentVisibilityTool`
 * factory, two per target (`pull_request_review_comment`, `pull_request_review`).
 */

import {
  asArray,
  defined,
  fail,
  optionalString,
  requireString,
  seg,
  toPositiveInt,
} from '../util.js';

/** GraphQL document resolving a pull request's global node id. */
const PULL_REQUEST_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id }
  }
}`;

const CONVERT_TO_DRAFT_MUTATION = `mutation($input: ConvertPullRequestToDraftInput!) {
  convertPullRequestToDraft(input: $input) { pullRequest { id isDraft } }
}`;

const MARK_READY_FOR_REVIEW_MUTATION = `mutation($input: MarkPullRequestReadyForReviewInput!) {
  markPullRequestReadyForReview(input: $input) { pullRequest { id isDraft } }
}`;

const ADD_PULL_REQUEST_REVIEW_MUTATION = `mutation($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { id } }
}`;

const SUBMIT_PULL_REQUEST_REVIEW_MUTATION = `mutation($input: SubmitPullRequestReviewInput!) {
  submitPullRequestReview(input: $input) { pullRequestReview { id } }
}`;

const DELETE_PULL_REQUEST_REVIEW_MUTATION = `mutation($input: DeletePullRequestReviewInput!) {
  deletePullRequestReview(input: $input) { pullRequestReview { id } }
}`;

const RESOLVE_REVIEW_THREAD_MUTATION = `mutation($input: ResolveReviewThreadInput!) {
  resolveReviewThread(input: $input) { thread { id isResolved } }
}`;

const UNRESOLVE_REVIEW_THREAD_MUTATION = `mutation($input: UnresolveReviewThreadInput!) {
  unresolveReviewThread(input: $input) { thread { id isResolved } }
}`;

const ADD_PULL_REQUEST_REVIEW_THREAD_MUTATION = `mutation($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) { thread { id } }
}`;

const VIEWER_QUERY = `query { viewer { id } }`;

const PENDING_REVIEWS_QUERY = `query($owner: String!, $name: String!, $prNum: Int!, $after: String, $states: [PullRequestReviewState!]) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNum) {
      reviews(first: 100, after: $after, states: $states) {
        nodes {
          id
          author {
            ... on Bot { botId: id }
            ... on EnterpriseUserAccount { enterpriseUserAccountId: id }
            ... on Mannequin { mannequinId: id }
            ... on Organization { organizationId: id }
            ... on User { userId: id }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const MINIMIZE_COMMENT_MUTATION = `mutation($input: MinimizeCommentInput!) {
  minimizeComment(input: $input) { minimizedComment { isMinimized minimizedReason } }
}`;

const UNMINIMIZE_COMMENT_MUTATION = `mutation($input: UnminimizeCommentInput!) {
  unminimizeComment(input: $input) { unminimizedComment { isMinimized } }
}`;

/** Classifiers accepted by the hide_* tools (comment_minimize.go). */
const COMMENT_CLASSIFIERS = [
  'SPAM',
  'ABUSE',
  'OFF_TOPIC',
  'OUTDATED',
  'DUPLICATE',
  'RESOLVED',
  'LOW_QUALITY',
];

/** Required positive integer argument. */
function requirePositiveInt(args, key) {
  const raw = args?.[key];
  if (raw === undefined || raw === null || raw === '') fail(`missing required argument: ${key}`);
  const value = toPositiveInt(raw, undefined);
  if (value === undefined) fail(`${key} must be greater than 0`);
  return value;
}

/** Non-empty string or undefined. */
function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** MinimalResponse, mirroring {id: fmt.Sprintf("%d", pr.GetID()), url: pr.GetHTMLURL()}. */
function minimalResponse(pr) {
  return { id: String(pr?.id ?? ''), url: pr?.html_url ?? '' };
}

/** Split `reviewers` into user logins and `org/team` slugs (splitPullRequestReviewers). */
function splitPullRequestReviewers(reviewers) {
  const users = [];
  const teams = [];
  for (const reviewer of asArray(reviewers)) {
    if (typeof reviewer !== 'string' || reviewer === '') continue;
    const slash = reviewer.indexOf('/');
    if (slash > 0) {
      const org = reviewer.slice(0, slash);
      const team = reviewer.slice(slash + 1);
      if (org !== '' && team !== '' && !team.includes('/')) {
        teams.push(team);
        continue;
      }
    }
    users.push(reviewer);
  }
  return { users, teams };
}

/** GraphQL lookup of the viewer's pending review on a pull request. */
async function pendingReviewId(ctx, owner, repo, pullNumber) {
  const viewer = await ctx.client.graphql(VIEWER_QUERY, {}, { signal: ctx.signal });
  const viewerId = viewer?.viewer?.id ?? null;
  let after = null;
  for (;;) {
    const data = await ctx.client.graphql(
      PENDING_REVIEWS_QUERY,
      { owner, name: repo, prNum: pullNumber, after, states: ['PENDING'] },
      { signal: ctx.signal },
    );
    const reviews = data?.repository?.pullRequest?.reviews;
    for (const review of asArray(reviews?.nodes)) {
      const author = review?.author ?? {};
      const authorId =
        author.botId ??
        author.enterpriseUserAccountId ??
        author.mannequinId ??
        author.organizationId ??
        author.userId;
      if (authorId != null && viewerId != null && authorId === viewerId) return review.id;
    }
    if (!reviews?.pageInfo?.hasNextPage) fail('No pending review found for the viewer');
    after = reviews.pageInfo.endCursor ?? null;
  }
}

/** GraphQL id of a pull request. */
async function pullRequestNodeId(ctx, owner, repo, pullNumber) {
  const data = await ctx.client.graphql(
    PULL_REQUEST_ID_QUERY,
    { owner, name: repo, number: pullNumber },
    { signal: ctx.signal },
  );
  return data?.repository?.pullRequest?.id ?? null;
}

/** PATCH a single field of a pull request (prUpdateTool: title/body/state). */
async function updateSingleField(ctx, owner, repo, pullNumber, body) {
  const pr = await ctx.client.patch(`/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}`, body, {
    signal: ctx.signal,
  });
  return minimalResponse(pr);
}

/** GraphQL id of the pull request plus its current draft state. */
async function pullRequestDraftState(ctx, owner, repo, pullNumber) {
  const data = await ctx.client.graphql(
    PULL_REQUEST_ID_QUERY,
    { owner, name: repo, number: pullNumber },
    { signal: ctx.signal },
  );
  const node = data?.repository?.pullRequest;
  if (node?.id == null) fail('failed to get pull request');
  return node.id;
}

/**
 * Update the title of an existing pull request.
 */
async function updatePullRequestTitle(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const title = requireString(args, 'title');
  return updateSingleField(ctx, owner, repo, pullNumber, { title });
}

/**
 * Update the body description of an existing pull request.
 */
async function updatePullRequestBody(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const body = requireString(args, 'body');
  return updateSingleField(ctx, owner, repo, pullNumber, { body });
}

/**
 * Update the state of an existing pull request (open or closed).
 */
async function updatePullRequestState(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const state = requireString(args, 'state');
  return updateSingleField(ctx, owner, repo, pullNumber, { state });
}

/**
 * Mark a pull request as draft or ready for review.
 */
async function updatePullRequestDraftState(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const draft = args?.draft === true || args?.draft === 'true';
  const pullRequestId = await pullRequestDraftState(ctx, owner, repo, pullNumber);
  if (draft) {
    await ctx.client.graphql(
      CONVERT_TO_DRAFT_MUTATION,
      { input: { pullRequestId } },
      { signal: ctx.signal },
    );
    return { message: 'pull request converted to draft' };
  }
  await ctx.client.graphql(
    MARK_READY_FOR_REVIEW_MUTATION,
    { input: { pullRequestId } },
    { signal: ctx.signal },
  );
  return { message: 'pull request marked as ready for review' };
}

/**
 * Request reviewers for a pull request.
 */
async function requestPullRequestReviewers(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const reviewers = asArray(args?.reviewers).filter(
    (value) => typeof value === 'string' && value !== '',
  );
  if (reviewers.length === 0) fail('missing required parameter: reviewers');
  const { users, teams } = splitPullRequestReviewers(reviewers);
  const response = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}/requested_reviewers`,
    defined({ reviewers: users, team_reviewers: teams }),
    { signal: ctx.signal },
  );
  return minimalResponse(response);
}

/**
 * Create a review on a pull request. If event is provided, the review is submitted
 * immediately; otherwise a pending review is created.
 */
async function createPullRequestReview(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const body = optionalString(args, 'body');
  const event = optionalString(args, 'event');
  const commitID = optionalString(args, 'commitID');

  const pullRequestId = await pullRequestNodeId(ctx, owner, repo, pullNumber);
  const input = defined({
    pullRequestId,
    commitOID: nonEmpty(commitID),
    event: nonEmpty(event),
    body: nonEmpty(event) ? (body ?? '') : undefined,
  });
  await ctx.client.graphql(ADD_PULL_REQUEST_REVIEW_MUTATION, { input }, { signal: ctx.signal });
  return {
    message: nonEmpty(event)
      ? 'pull request review submitted successfully'
      : 'pending pull request created',
  };
}

/**
 * Submit a pending pull request review.
 */
async function submitPendingPullRequestReview(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const event = requireString(args, 'event');
  const body = optionalString(args, 'body') ?? '';

  const reviewId = await pendingReviewId(ctx, owner, repo, pullNumber);
  await ctx.client.graphql(
    SUBMIT_PULL_REQUEST_REVIEW_MUTATION,
    { input: { pullRequestReviewId: reviewId, event, body } },
    { signal: ctx.signal },
  );
  return { message: 'pending pull request review successfully submitted' };
}

/**
 * Delete a pending pull request review.
 */
async function deletePendingPullRequestReview(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');

  const reviewId = await pendingReviewId(ctx, owner, repo, pullNumber);
  await ctx.client.graphql(
    DELETE_PULL_REQUEST_REVIEW_MUTATION,
    { input: { pullRequestReviewId: reviewId } },
    { signal: ctx.signal },
  );
  return { message: 'pending pull request review successfully deleted' };
}

/**
 * Add a review comment to the current user's pending pull request review.
 */
async function addPullRequestReviewComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const path = requireString(args, 'path');
  const body = requireString(args, 'body');
  const subjectType = requireString(args, 'subjectType');
  const line = toPositiveInt(args?.line, undefined);
  const side = optionalString(args, 'side');
  const startLine = toPositiveInt(args?.startLine, undefined);
  const startSide = optionalString(args, 'startSide');

  const reviewId = await pendingReviewId(ctx, owner, repo, pullNumber);
  const input = defined({
    path,
    body,
    subjectType,
    line,
    side,
    startLine,
    startSide,
    pullRequestReviewId: reviewId,
  });
  const data = await ctx.client.graphql(ADD_PULL_REQUEST_REVIEW_THREAD_MUTATION, { input }, {
    signal: ctx.signal,
  });
  if (data?.addPullRequestReviewThread?.thread?.id == null) {
    fail(
      "Failed to add comment to pending review. Possible reasons:\n\t- The line number doesn't exist in the pull request diff\n\t- The file path is incorrect\n\t- The side (LEFT/RIGHT) is invalid for the specified line\n",
    );
  }
  return { message: 'pull request review comment successfully added to pending review' };
}

/**
 * Resolve a review thread on a pull request. Resolving an already-resolved thread is a no-op.
 */
async function resolveReviewThread(args, ctx) {
  const threadID = requireString(args, 'threadID');
  const resolutionReason = optionalString(args, 'resolutionReason');
  if (threadID === '') fail('threadId is required for resolve_thread and unresolve_thread methods');
  await ctx.client.graphql(
    RESOLVE_REVIEW_THREAD_MUTATION,
    { input: defined({ threadId: threadID, resolutionReason }) },
    { signal: ctx.signal },
  );
  return { message: 'review thread resolved successfully' };
}

/**
 * Unresolve a previously resolved review thread on a pull request. Unresolving an
 * already-unresolved thread is a no-op.
 */
async function unresolveReviewThread(args, ctx) {
  const threadID = requireString(args, 'threadID');
  if (threadID === '') fail('threadId is required for resolve_thread and unresolve_thread methods');
  await ctx.client.graphql(
    UNRESOLVE_REVIEW_THREAD_MUTATION,
    { input: { threadId: threadID } },
    { signal: ctx.signal },
  );
  return { message: 'review thread unresolved successfully' };
}

/**
 * Add a reaction to a pull request review comment.
 */
async function addPullRequestReviewCommentReaction(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requirePositiveInt(args, 'comment_id');
  const content = requireString(args, 'content');
  const reaction = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/pulls/comments/${commentId}/reactions`,
    { content },
    { signal: ctx.signal },
  );
  const reactionId = reaction?.id ?? '';
  return {
    id: String(reactionId),
    url: `${ctx.client.apiBaseUrl}/repos/${seg(owner)}/${seg(repo)}/pulls/comments/${commentId}/reactions/${reactionId}`,
  };
}

/**
 * Remove a reaction from a pull request review comment.
 */
async function removePullRequestReviewCommentReaction(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requirePositiveInt(args, 'comment_id');
  const reactionId = requirePositiveInt(args, 'reaction_id');
  await ctx.client.delete(
    `/repos/${seg(owner)}/${seg(repo)}/pulls/comments/${commentId}/reactions/${reactionId}`,
    undefined,
    { signal: ctx.signal },
  );
  return { message: 'reaction successfully removed from pull request review comment' };
}

/**
 * Shared body of the four hide/unhide tools (comment_minimize.go's
 * `commentVisibilityTool` + `setCommentVisibility`).
 */
async function setCommentVisibility(args, ctx, options) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  let classifier;
  if (options.hide) {
    classifier = requireString(args, 'classifier').toUpperCase();
    if (!COMMENT_CLASSIFIERS.includes(classifier)) {
      fail(
        `invalid classifier "${classifier}": must be one of [${COMMENT_CLASSIFIERS.join(' ')}]`,
      );
    }
  }

  let lookupPath;
  if (options.review) {
    const pullNumber = requirePositiveInt(args, 'pullNumber');
    const reviewId = requirePositiveInt(args, 'review_id');
    lookupPath = `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}/reviews/${reviewId}`;
  } else {
    const commentId = requirePositiveInt(args, 'comment_id');
    lookupPath = `/repos/${seg(owner)}/${seg(repo)}/pulls/comments/${commentId}`;
  }

  const subject = await ctx.client.get(lookupPath, { signal: ctx.signal });
  const nodeId = subject?.node_id;
  if (!nodeId) fail(`${options.errorMessage}: response has no node ID`);

  const data = options.hide
    ? await ctx.client.graphql(
        MINIMIZE_COMMENT_MUTATION,
        { input: { subjectId: nodeId, classifier } },
        { signal: ctx.signal },
      )
    : await ctx.client.graphql(
        UNMINIMIZE_COMMENT_MUTATION,
        { input: { subjectId: nodeId } },
        { signal: ctx.signal },
      );
  const minimized = options.hide
    ? data?.minimizeComment?.minimizedComment
    : data?.unminimizeComment?.unminimizedComment;
  return defined({
    node_id: nodeId,
    is_minimized: Boolean(minimized?.isMinimized),
    minimized_reason: options.hide ? nonEmpty(minimized?.minimizedReason) : undefined,
  });
}

/**
 * Hide (minimize) an inline review comment on a pull request diff.
 */
async function hidePullRequestReviewComment(args, ctx) {
  return setCommentVisibility(args, ctx, {
    hide: true,
    review: false,
    errorMessage: 'failed to get pull request review comment',
  });
}

/**
 * Unhide (unminimize) a previously hidden inline review comment on a pull request diff.
 */
async function unhidePullRequestReviewComment(args, ctx) {
  return setCommentVisibility(args, ctx, {
    hide: false,
    review: false,
    errorMessage: 'failed to get pull request review comment',
  });
}

/**
 * Hide (minimize) the body of a submitted pull request review.
 */
async function hidePullRequestReview(args, ctx) {
  return setCommentVisibility(args, ctx, {
    hide: true,
    review: true,
    errorMessage: 'failed to get pull request review',
  });
}

/**
 * Unhide (unminimize) the previously hidden body of a submitted pull request review.
 */
async function unhidePullRequestReview(args, ctx) {
  return setCommentVisibility(args, ctx, {
    hide: false,
    review: true,
    errorMessage: 'failed to get pull request review',
  });
}

export default {
  update_pull_request_title: updatePullRequestTitle,
  update_pull_request_body: updatePullRequestBody,
  update_pull_request_state: updatePullRequestState,
  update_pull_request_draft_state: updatePullRequestDraftState,
  request_pull_request_reviewers: requestPullRequestReviewers,
  create_pull_request_review: createPullRequestReview,
  submit_pending_pull_request_review: submitPendingPullRequestReview,
  delete_pending_pull_request_review: deletePendingPullRequestReview,
  add_pull_request_review_comment: addPullRequestReviewComment,
  resolve_review_thread: resolveReviewThread,
  unresolve_review_thread: unresolveReviewThread,
  add_pull_request_review_comment_reaction: addPullRequestReviewCommentReaction,
  remove_pull_request_review_comment_reaction: removePullRequestReviewCommentReaction,
  hide_pull_request_review_comment: hidePullRequestReviewComment,
  unhide_pull_request_review_comment: unhidePullRequestReviewComment,
  hide_pull_request_review: hidePullRequestReview,
  unhide_pull_request_review: unhidePullRequestReview,
};

/**
 * issues_granular.js — 14 tool handlers.
 *
 *   - set_issue_fields
 *   - update_issue_title
 *   - update_issue_body
 *   - update_issue_assignees
 *   - update_issue_labels
 *   - update_issue_milestone
 *   - update_issue_type
 *   - update_issue_state
 *   - add_issue_reaction
 *   - remove_issue_reaction
 *   - add_issue_comment_reaction
 *   - remove_issue_comment_reaction
 *   - hide_issue_comment
 *   - unhide_issue_comment
 *
 * Ported from the upstream Go server:
 *   pkg/github/issues_granular.go   (single-field issue updates, set_issue_fields, reactions)
 *   pkg/github/comment_minimize.go  (hide/unhide, via the shared `commentVisibilityTool`
 *                                    factory parameterised for the issue-comment target)
 *   pkg/github/granular_issue_types.go (the In/Out structs and the argument normalizers)
 */

import {
  defined,
  fail,
  issueDatabaseId,
  optionalString,
  requireEnum,
  requireString,
  seg,
  toPositiveInt,
} from '../util.js';

/** The classifiers `minimizeComment` accepts (upstream `commentClassifiers`). */
const COMMENT_CLASSIFIERS = ['SPAM', 'ABUSE', 'OFF_TOPIC', 'OUTDATED', 'DUPLICATE', 'RESOLVED', 'LOW_QUALITY'];

/** Entry shapes for the heterogeneous string/object lists of assignees and labels. */
const ASSIGNEE_ENTRY = {
  field: 'login',
  missing: "each assignee object must have a 'login' string",
  invalid:
    "each assignee must be a string or an object with 'login' and optional 'rationale', 'confidence', and/or 'is_suggestion'",
  rationale: 'assignee rationale',
};

const LABEL_ENTRY = {
  field: 'name',
  missing: "each label object must have a 'name' string",
  invalid:
    "each label must be a string or an object with 'name' and optional 'rationale', 'confidence', and/or 'is_suggestion'",
  rationale: 'label rationale',
};

const ISSUE_FIELDS_QUERY = `
  query($owner: String!, $name: String!, $issueNumber: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) { id }
    }
  }`;

const SET_ISSUE_FIELD_VALUE_MUTATION = `
  mutation($input: SetIssueFieldValueInput!) {
    setIssueFieldValue(input: $input) {
      issue { id url }
    }
  }`;

const MINIMIZE_COMMENT_MUTATION = `
  mutation($input: MinimizeCommentInput!) {
    minimizeComment(input: $input) {
      minimizedComment { isMinimized minimizedReason }
    }
  }`;

const UNMINIMIZE_COMMENT_MUTATION = `
  mutation($input: UnminimizeCommentInput!) {
    unminimizeComment(input: $input) {
      unminimizedComment { isMinimized }
    }
  }`;

/** Does `object` carry `key` (even when the value is null)? */
function hasKey(object, key) {
  return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

/** Read a required positive integer argument (upstream `RequiredInt` / `requiredPositiveBigInt`). */
function requirePositiveInt(args, key) {
  const value = toPositiveInt(args?.[key], undefined);
  if (value === undefined) fail(`missing required argument: ${key}`);
  return value;
}

/** `owner`/`repo`/`issue_number` — the coordinate shared by the single-issue tools. */
function issueCoordinate(args) {
  return {
    owner: requireString(args, 'owner'),
    repo: requireString(args, 'repo'),
    issueNumber: requirePositiveInt(args, 'issue_number'),
  };
}

/** The upstream `MinimalResponse` (`{id, url}`) that every issue mutation returns. */
function minimalResponse(issue) {
  return { id: String(issue?.id ?? 0), url: issue?.html_url ?? '' };
}

/** `PATCH /repos/{owner}/{repo}/issues/{n}` — shared by every single-field updater. */
async function patchIssue(ctx, owner, repo, issueNumber, body) {
  const issue = await ctx.client.patch(`/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}`, body, {
    signal: ctx.signal,
  });
  return minimalResponse(issue);
}

/** Upstream `normalizeConfidence`: trim + upper-case, rejecting anything off-enum. */
function normalizeConfidence(value) {
  const confidence = String(value ?? '').trim().toUpperCase();
  if (confidence !== '' && !['LOW', 'MEDIUM', 'HIGH'].includes(confidence)) {
    fail('confidence must be one of: LOW, MEDIUM, HIGH');
  }
  return confidence;
}

/** Trim an optional `rationale` and enforce the upstream 280-character cap. */
function normalizeRationale(container, label) {
  const rationale = String(optionalString(container, 'rationale') ?? '');
  if ([...rationale].length > 280) fail(`${label} must be 280 characters or less`);
  return rationale;
}

/** Upstream `OptionalParam[bool]` for `is_suggestion`. */
function readIsSuggestion(container) {
  const value = container?.is_suggestion;
  if (value === true || value === 'true') return true;
  return false;
}

/**
 * Normalize the string-or-object entry lists used by `update_issue_assignees` and
 * `update_issue_labels` (upstream `GranularIssueAssignee` / `GranularIssueLabel`).
 * String entries keep their string form; object entries keep intent metadata.
 */
function normalizeIntentEntries(raw, spec, argumentName) {
  if (raw === undefined) fail(`missing required parameter: ${argumentName}`);
  if (!Array.isArray(raw)) fail(`parameter ${argumentName} must be an array`);
  const entries = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      entries.push({ [spec.field]: item, rationale: '', confidence: '', isSuggestion: false });
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(spec.invalid);
    const value = optionalString(item, spec.field);
    if (value === undefined) fail(spec.missing);
    const rationale = normalizeRationale(item, spec.rationale);
    const confidence = normalizeConfidence(item?.confidence);
    const isSuggestion = readIsSuggestion(item);
    entries.push({ [spec.field]: value, rationale, confidence, isSuggestion });
  }
  return entries;
}

/**
 * Build the assignees/labels request body: `{labels: ["a","b"]}` when every entry is a
 * plain string, otherwise `{labels: ["a", {name, rationale?, confidence?, suggest?}]}`
 * (upstream `granularIssueAssigneesPayload` / `granularIssueLabelsPayload`).
 */
function intentPayload(entries, spec, argumentName) {
  const payload = [];
  const plain = [];
  let objectForm = false;
  for (const entry of entries) {
    plain.push(entry[spec.field]);
    if (entry.rationale === '' && entry.confidence === '' && !entry.isSuggestion) {
      payload.push(entry[spec.field]);
    } else {
      objectForm = true;
      payload.push(
        defined({
          [spec.field]: entry[spec.field],
          rationale: entry.rationale === '' ? undefined : entry.rationale,
          confidence: entry.confidence === '' ? undefined : entry.confidence,
          suggest: entry.isSuggestion ? true : undefined,
        }),
      );
    }
  }
  return { [argumentName]: objectForm ? payload : plain };
}

/** `update_issue_title` — PATCH the issue title. */
async function updateIssueTitle(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const title = requireString(args, 'title');
  return patchIssue(ctx, owner, repo, issueNumber, { title });
}

/** `update_issue_body` — PATCH the issue body. */
async function updateIssueBody(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const body = requireString(args, 'body');
  return patchIssue(ctx, owner, repo, issueNumber, { body });
}

/** `update_issue_assignees` — PATCH the issue assignees (replaces the current set). */
async function updateIssueAssignees(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const entries = normalizeIntentEntries(args?.assignees, ASSIGNEE_ENTRY, 'assignees');
  const body = intentPayload(entries, ASSIGNEE_ENTRY, 'assignees');
  return patchIssue(ctx, owner, repo, issueNumber, body);
}

/** `update_issue_labels` — PATCH the issue labels (replaces the current set). */
async function updateIssueLabels(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const entries = normalizeIntentEntries(args?.labels, LABEL_ENTRY, 'labels');
  const body = intentPayload(entries, LABEL_ENTRY, 'labels');
  return patchIssue(ctx, owner, repo, issueNumber, body);
}

/** `update_issue_milestone` — PATCH the issue milestone number. */
async function updateIssueMilestone(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const milestone = requirePositiveInt(args, 'milestone');
  return patchIssue(ctx, owner, repo, issueNumber, { milestone });
}

/** `update_issue_type` — PATCH the issue type, clearing it when `issue_type` is null. */
async function updateIssueType(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  if (!hasKey(args, 'issue_type')) fail('missing required argument: issue_type');
  const raw = args.issue_type;
  let issueType = null;
  if (raw !== null && raw !== undefined) {
    issueType = String(raw).trim();
    if (issueType === '') fail('parameter issue_type must not be empty');
  }
  const rationale = normalizeRationale(args, 'parameter rationale');
  const confidence = normalizeConfidence(args?.confidence);
  const isSuggestion = readIsSuggestion(args);
  if (issueType === null && (rationale !== '' || confidence !== '' || isSuggestion)) {
    fail('suggestion metadata is not supported when removing an issue type; omit rationale, confidence, and is_suggestion');
  }

  let body;
  if (issueType === null) {
    body = { type: null };
  } else if (rationale !== '' || isSuggestion || confidence !== '') {
    body = {
      type: defined({
        value: issueType,
        rationale: rationale === '' ? undefined : rationale,
        confidence: confidence === '' ? undefined : confidence,
        suggest: isSuggestion ? true : undefined,
      }),
    };
  } else {
    body = { type: issueType };
  }
  return patchIssue(ctx, owner, repo, issueNumber, body);
}

/** `update_issue_state` — PATCH the issue state, optionally closing as a duplicate. */
async function updateIssueState(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const state = requireEnum(requireString(args, 'state'), ['open', 'closed'], 'state');
  const stateReason = optionalString(args, 'state_reason') ?? '';
  const rationale = normalizeRationale(args, 'parameter rationale');
  const confidence = normalizeConfidence(args?.confidence);
  const isSuggestion = readIsSuggestion(args);
  const duplicateOf = toPositiveInt(args?.duplicate_of, 0);

  if (stateReason !== '' && state !== 'closed') fail("state_reason can only be used when state is 'closed'");
  if (duplicateOf !== 0 && stateReason !== 'duplicate') fail("duplicate_of can only be used when state_reason is 'duplicate'");
  if (isSuggestion && stateReason === 'duplicate' && duplicateOf === 0) {
    fail('duplicate_of is required when suggesting a close as duplicate');
  }

  let body;
  if (rationale !== '' || isSuggestion || confidence !== '' || duplicateOf !== 0) {
    body = defined({
      state: defined({
        value: state,
        rationale: rationale === '' ? undefined : rationale,
        confidence: confidence === '' ? undefined : confidence,
        suggest: isSuggestion ? true : undefined,
      }),
      state_reason: stateReason === '' ? undefined : stateReason,
    });
    if (duplicateOf !== 0) {
      // The upstream resolves the canonical issue number to its database ID first.
      const { databaseId } = await issueDatabaseId(ctx.client, owner, repo, duplicateOf, ctx.signal);
      body.duplicate_issue_id = databaseId;
    }
  } else {
    body = defined({ state, state_reason: stateReason === '' ? undefined : stateReason });
  }
  return patchIssue(ctx, owner, repo, issueNumber, body);
}

/** Build one `IssueFieldCreateOrUpdateInput` from a `fields[]` entry (upstream normalizer). */
function issueFieldMutationEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail("each field must be an object with 'field_id' and a value");
  }
  const fieldId = optionalString(raw, 'field_id');
  if (fieldId === undefined) fail('field_id is required and must be a string');

  const entry = { fieldId };
  let valueCount = 0;

  const textValue = optionalString(raw, 'text_value');
  if (textValue !== undefined) {
    entry.textValue = textValue;
    valueCount += 1;
  }
  if (hasKey(raw, 'number_value')) {
    const numberValue = raw.number_value;
    if (typeof numberValue === 'number' && Number.isFinite(numberValue)) {
      entry.numberValue = numberValue;
      valueCount += 1;
    }
  }
  const dateValue = optionalString(raw, 'date_value');
  if (dateValue !== undefined) {
    entry.dateValue = dateValue;
    valueCount += 1;
  }
  const singleSelectOptionId = optionalString(raw, 'single_select_option_id');
  if (singleSelectOptionId !== undefined) {
    entry.singleSelectOptionId = singleSelectOptionId;
    valueCount += 1;
  }
  if (hasKey(raw, 'delete') && (raw.delete === true || raw.delete === 'true')) {
    entry.delete = true;
    valueCount += 1;
  }

  if (valueCount === 0) {
    fail('each field must have a value (text_value, number_value, date_value, single_select_option_id) or delete: true');
  }
  if (valueCount > 1) {
    fail(
      'each field must have exactly one value (text_value, number_value, date_value, single_select_option_id) or delete: true, but multiple were provided',
    );
  }

  if (hasKey(raw, 'rationale')) {
    const rationale = normalizeRationale(raw, 'field rationale');
    if (rationale !== '') entry.rationale = rationale;
  }
  const confidence = normalizeConfidence(raw?.confidence);
  if (confidence !== '') entry.confidence = confidence;
  if (readIsSuggestion(raw)) entry.suggest = true;

  return entry;
}

/**
 * `set_issue_fields` — GraphQL `setIssueFieldValue` with the organization-level
 * issue field values to create/update/delete.
 *
 * NOTE: the upstream sends the `GraphQL-Features: update_issue_suggestions` header
 * (ghcontext.WithGraphQLFeatures) to unlock the `rationale`/`suggest` input fields.
 * The shared client's `graphql()` helper forwards no custom headers, so those two
 * optional fields may be rejected by the API for accounts without the flag.
 */
async function setIssueFields(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const rawFields = args?.fields;
  if (rawFields === undefined) fail('missing required parameter: fields');
  if (!Array.isArray(rawFields)) fail('invalid parameter: fields must be an array');
  if (rawFields.length === 0) fail('fields array must not be empty');
  const issueFields = rawFields.map(issueFieldMutationEntry);

  const data = await ctx.client.graphql(
    ISSUE_FIELDS_QUERY,
    { owner, name: repo, issueNumber },
    { signal: ctx.signal },
  );
  const issueId = data?.repository?.issue?.id;
  if (!issueId) fail(`failed to get issue: issue #${issueNumber} not found in ${owner}/${repo}`);

  const result = await ctx.client.graphql(
    SET_ISSUE_FIELD_VALUE_MUTATION,
    { input: { issueId, issueFields } },
    { signal: ctx.signal },
  );
  const issue = result?.setIssueFieldValue?.issue;
  return { id: String(issue?.id ?? ''), url: issue?.url ?? '' };
}

/** `add_issue_reaction` — POST a reaction to an issue or pull request. */
async function addIssueReaction(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const content = requireString(args, 'content');
  const reaction = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/reactions`,
    { content },
    { signal: ctx.signal },
  );
  const reactionId = reaction?.id ?? 0;
  return {
    id: String(reactionId),
    url: ctx.client.restUrl(`repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/reactions/${reactionId}`),
  };
}

/** `remove_issue_reaction` — DELETE a reaction from an issue or pull request. */
async function removeIssueReaction(args, ctx) {
  const { owner, repo, issueNumber } = issueCoordinate(args);
  const reactionId = requirePositiveInt(args, 'reaction_id');
  await ctx.client.delete(
    `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/reactions/${reactionId}`,
    undefined,
    { signal: ctx.signal },
  );
  return { message: 'reaction successfully removed from issue' };
}

/** `add_issue_comment_reaction` — POST a reaction to an issue/PR conversation comment. */
async function addIssueCommentReaction(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requirePositiveInt(args, 'comment_id');
  const content = requireString(args, 'content');
  const reaction = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}/reactions`,
    { content },
    { signal: ctx.signal },
  );
  const reactionId = reaction?.id ?? 0;
  return {
    id: String(reactionId),
    url: ctx.client.restUrl(`repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}/reactions/${reactionId}`),
  };
}

/** `remove_issue_comment_reaction` — DELETE a reaction from an issue/PR comment. */
async function removeIssueCommentReaction(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requirePositiveInt(args, 'comment_id');
  const reactionId = requirePositiveInt(args, 'reaction_id');
  await ctx.client.delete(
    `/repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}/reactions/${reactionId}`,
    undefined,
    { signal: ctx.signal },
  );
  return { message: 'reaction successfully removed from issue comment' };
}

/**
 * Resolve the GraphQL node ID of an issue/PR conversation comment
 * (upstream `issueCommentVisibilityTarget.resolveNodeID`).
 */
async function issueCommentNodeId(ctx, owner, repo, commentId) {
  const comment = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}`, {
    signal: ctx.signal,
  });
  const nodeId = comment?.node_id;
  if (!nodeId) fail('failed to get issue comment: response has no node ID');
  return nodeId;
}

/** `hide_issue_comment` — REST lookup + GraphQL `minimizeComment`. */
async function hideIssueComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requirePositiveInt(args, 'comment_id');
  const classifier = requireEnum(requireString(args, 'classifier'), COMMENT_CLASSIFIERS, 'classifier');
  const nodeId = await issueCommentNodeId(ctx, owner, repo, commentId);
  const data = await ctx.client.graphql(
    MINIMIZE_COMMENT_MUTATION,
    { input: { subjectId: nodeId, classifier } },
    { signal: ctx.signal },
  );
  const comment = data?.minimizeComment?.minimizedComment;
  return defined({
    node_id: nodeId,
    is_minimized: Boolean(comment?.isMinimized),
    minimized_reason: comment?.minimizedReason ? String(comment.minimizedReason) : undefined,
  });
}

/** `unhide_issue_comment` — REST lookup + GraphQL `unminimizeComment`. */
async function unhideIssueComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requirePositiveInt(args, 'comment_id');
  const nodeId = await issueCommentNodeId(ctx, owner, repo, commentId);
  const data = await ctx.client.graphql(
    UNMINIMIZE_COMMENT_MUTATION,
    { input: { subjectId: nodeId } },
    { signal: ctx.signal },
  );
  const comment = data?.unminimizeComment?.unminimizedComment;
  return { node_id: nodeId, is_minimized: Boolean(comment?.isMinimized) };
}

export default {
  set_issue_fields: setIssueFields,
  update_issue_title: updateIssueTitle,
  update_issue_body: updateIssueBody,
  update_issue_assignees: updateIssueAssignees,
  update_issue_labels: updateIssueLabels,
  update_issue_milestone: updateIssueMilestone,
  update_issue_type: updateIssueType,
  update_issue_state: updateIssueState,
  add_issue_reaction: addIssueReaction,
  remove_issue_reaction: removeIssueReaction,
  add_issue_comment_reaction: addIssueCommentReaction,
  remove_issue_comment_reaction: removeIssueCommentReaction,
  hide_issue_comment: hideIssueComment,
  unhide_issue_comment: unhideIssueComment,
};

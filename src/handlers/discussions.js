/**
 * discussions.js — 5 tool handlers, all GraphQL.
 *
 *   - discussion_comment_write
 *   - get_discussion
 *   - get_discussion_comments
 *   - list_discussion_categories
 *   - list_discussions
 *
 * Ported from github-mcp-server:
 *   pkg/github/discussions.go
 *   pkg/github/discussion_notification_inputs.go
 *   pkg/github/discussion_notification_outputs.go
 *   pkg/github/params.go                (DefaultGraphQLPageSize, cursor pagination)
 *   pkg/sanitize/sanitize.go            (content / plain-text sanitization)
 */
import { fail, optionalBoolean, optionalString, requireString, toPositiveInt } from '../util.js';

/** Upstream `DefaultGraphQLPageSize`. */
const DEFAULT_GRAPHQL_PAGE_SIZE = 30;
/** Organisation-level discussions live in the `.github` repository. */
const DEFAULT_DISCUSSION_REPO = '.github';
/** Upstream hardcodes `discussionCategories(first: 25)`. */
const DISCUSSION_CATEGORY_PAGE_SIZE = 25;
/** GitHub's hard maximum for nested replies per comment. */
const REPLIES_PAGE_SIZE = 100;

/* ------------------------------------------------------------------ *
 * Sanitization (port of pkg/sanitize)
 * ------------------------------------------------------------------ */

const INVISIBLE_CHARACTER =
  /[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0001}\u{E0020}-\u{E007F}]/u;
const HAN_CHARACTER =
  /[\u2E80-\u2EFF\u2F00-\u2FDF\u3040-\u30FF\u3100-\u312F\u31A0-\u31BF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u{20000}-\u{3FFFF}]/u;
/** HTML tags and comments; stands in for bluemonday's StrictPolicy. */
const HTML_MARKUP = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;

function isVariationSelector(character) {
  const code = character.codePointAt(0);
  return (code >= 0xfe00 && code <= 0xfe0f) || (code >= 0xe0100 && code <= 0xe01ef);
}

function isGraphicBase(character) {
  if (!character) return false;
  const code = character.codePointAt(0);
  if (code <= 0x20 || code === 0x7f) return false;
  return !isVariationSelector(character);
}

/**
 * A variation selector survives only when it forms a valid sequence with the
 * preceding graphic base character (VS17+ additionally requires a Han base).
 */
function keepsVariationSelector(character, base) {
  if (!base) return false;
  const code = character.codePointAt(0);
  const baseCode = base.codePointAt(0);
  if (baseCode < 0x80) {
    const asciiBase = base === '#' || base === '*' || (baseCode >= 0x30 && baseCode <= 0x39);
    return asciiBase && (code === 0xfe0e || code === 0xfe0f);
  }
  if (code >= 0xe0100) return HAN_CHARACTER.test(base);
  return true;
}

/** Port of `sanitize.FilterInvisibleCharacters`. */
function filterInvisibleCharacters(value) {
  if (typeof value !== 'string' || value === '') return value ?? '';
  let output = '';
  let base = '';
  for (const character of value) {
    if (INVISIBLE_CHARACTER.test(character)) continue;
    if (isVariationSelector(character)) {
      if (keepsVariationSelector(character, base)) output += character;
      continue;
    }
    output += character;
    base = isGraphicBase(character) ? character : '';
  }
  return output;
}

/** Port of `sanitize.PlainText` — invisible characters removed, markup stripped. */
function plainText(value) {
  if (typeof value !== 'string' || value === '') return value ?? '';
  return filterInvisibleCharacters(value.replace(HTML_MARKUP, ''));
}

/** Port of `sanitize.Content` — invisible characters removed, markup preserved. */
function content(value) {
  return filterInvisibleCharacters(typeof value === 'string' ? value : '');
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Required positive integer argument (plugin-wide message convention). */
function requireInt(args, key) {
  const value = toPositiveInt(args?.[key], undefined);
  if (value === undefined) fail(`missing required argument: ${key}`);
  return value;
}

/** GraphQL page info as exposed by the typed discussion outputs. */
function pageInfoOutput(node) {
  const info = node?.pageInfo ?? {};
  return {
    hasNextPage: Boolean(info.hasNextPage),
    hasPreviousPage: Boolean(info.hasPreviousPage),
    startCursor: info.startCursor == null ? '' : String(info.startCursor),
    endCursor: info.endCursor == null ? '' : String(info.endCursor),
  };
}

/**
 * `OptionalCursorPaginationParams` + `ToGraphQLParams`: perPage defaults to 30,
 * a present `0` is normalized back to 30, and the 1..100 window is enforced.
 */
function cursorPagination(args) {
  const raw = args?.perPage;
  const provided = raw !== undefined && raw !== null && raw !== '';
  let perPage = provided ? Number(raw) : DEFAULT_GRAPHQL_PAGE_SIZE;
  if (!Number.isFinite(perPage)) fail('perPage must be an integer');
  perPage = Math.trunc(perPage);
  if (perPage === 0) perPage = DEFAULT_GRAPHQL_PAGE_SIZE;
  if (perPage > 100) fail(`perPage value ${perPage} exceeds maximum of 100`);
  if (perPage < 0) fail(`perPage value ${perPage} cannot be negative`);
  return { first: perPage, after: optionalString(args, 'after') };
}

/** The `id` of a discussion, resolved from its number. */
async function discussionNodeId(ctx, owner, repo, discussionNumber) {
  const query = `query($owner: String!, $repo: String!, $discussionNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $discussionNumber) { id }
  }
}`;
  const data = await ctx.client.graphql(query, { owner, repo, discussionNumber }, { signal: ctx.signal });
  return data?.repository?.discussion?.id;
}

/* ------------------------------------------------------------------ *
 * list_discussions
 * ------------------------------------------------------------------ */

/** List discussions in a repository, with an optional category filter and ordering. */
async function listDiscussions(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = optionalString(args, 'repo') ?? DEFAULT_DISCUSSION_REPO;
  const category = optionalString(args, 'category');
  const orderBy = optionalString(args, 'orderBy');
  const direction = optionalString(args, 'direction');
  const { first, after } = cursorPagination(args);

  // Ordering is only applied when both the field and the direction are given.
  const useOrdering = Boolean(orderBy && direction);
  const orderVars = useOrdering ? ', $orderByField: DiscussionOrderField!, $orderByDirection: OrderDirection!' : '';
  const categoryVar = category ? ', $categoryId: ID!' : '';
  const orderArgs = useOrdering ? ', orderBy: {field: $orderByField, direction: $orderByDirection}' : '';
  const categoryArgs = category ? ', categoryId: $categoryId' : '';

  const query = `query($owner: String!, $repo: String!, $first: Int!, $after: String${orderVars}${categoryVar}) {
  repository(owner: $owner, name: $repo) {
    discussions(first: $first, after: $after${categoryArgs}${orderArgs}) {
      nodes { number title createdAt updatedAt closed isAnswered answerChosenAt author { login } category { name } url }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      totalCount
    }
  }
}`;

  const variables = { owner, repo, first, after: after ?? null };
  if (useOrdering) {
    variables.orderByField = orderBy;
    variables.orderByDirection = direction;
  }
  if (category) variables.categoryId = category;

  const data = await ctx.client.graphql(query, variables, { signal: ctx.signal });
  const discussions = data?.repository?.discussions ?? {};
  const nodes = Array.isArray(discussions.nodes) ? discussions.nodes : [];

  return {
    discussions: nodes.map((node) => ({
      number: node?.number == null ? null : Number(node.number),
      title: node?.title == null ? null : plainText(String(node.title)),
      html_url: node?.url == null ? null : String(node.url),
      created_at: node?.createdAt ?? null,
      updated_at: node?.updatedAt ?? null,
      author: node?.author?.login == null ? '' : String(node.author.login),
      category: node?.category?.name == null ? '' : String(node.category.name),
    })),
    pageInfo: pageInfoOutput(discussions),
    totalCount: Number(discussions.totalCount ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * get_discussion
 * ------------------------------------------------------------------ */

/** Fetch a single discussion by number. */
async function getDiscussion(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const discussionNumber = requireInt(args, 'discussionNumber');

  const query = `query($owner: String!, $repo: String!, $discussionNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $discussionNumber) {
      number title body createdAt closed isAnswered answerChosenAt url category { name }
    }
  }
}`;

  const data = await ctx.client.graphql(query, { owner, repo, discussionNumber }, { signal: ctx.signal });
  const discussion = data?.repository?.discussion ?? {};

  const output = {
    number: Number(discussion.number ?? 0),
    title: plainText(discussion.title == null ? '' : String(discussion.title)),
    body: content(discussion.body == null ? '' : String(discussion.body)),
    html_url: discussion.url == null ? '' : String(discussion.url),
    closed: Boolean(discussion.closed),
    isAnswered: Boolean(discussion.isAnswered),
    createdAt: discussion.createdAt == null ? '' : String(discussion.createdAt),
    category: { name: discussion.category?.name == null ? '' : String(discussion.category.name) },
  };
  if (discussion.answerChosenAt != null) output.answerChosenAt = String(discussion.answerChosenAt);
  return output;
}

/* ------------------------------------------------------------------ *
 * get_discussion_comments
 * ------------------------------------------------------------------ */

/** List the top-level comments of a discussion, optionally with their replies. */
async function getDiscussionComments(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const discussionNumber = requireInt(args, 'discussionNumber');
  const includeReplies = optionalBoolean(args, 'includeReplies', false) === true;
  const { first, after } = cursorPagination(args);

  const nodeFields = includeReplies
    ? `id body isAnswer replies(first: ${REPLIES_PAGE_SIZE}) { nodes { id body isAnswer } totalCount }`
    : 'id body isAnswer';

  const query = `query($owner: String!, $repo: String!, $discussionNumber: Int!, $first: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    discussion(number: $discussionNumber) {
      comments(first: $first, after: $after) {
        nodes { ${nodeFields} }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        totalCount
      }
    }
  }
}`;

  const data = await ctx.client.graphql(
    query,
    { owner, repo, discussionNumber, first, after: after ?? null },
    { signal: ctx.signal },
  );
  const comments = data?.repository?.discussion?.comments ?? {};
  const nodes = Array.isArray(comments.nodes) ? comments.nodes : [];

  return {
    comments: nodes.map((node) => {
      const item = {
        id: node?.id == null ? '' : String(node.id),
        body: node?.body == null ? '' : String(node.body),
      };
      if (node?.isAnswer) item.isAnswer = true;
      if (includeReplies) {
        const replies = Array.isArray(node?.replies?.nodes) ? node.replies.nodes : [];
        if (replies.length > 0) {
          item.replies = replies.map((reply) => {
            const entry = {
              id: reply?.id == null ? '' : String(reply.id),
              body: reply?.body == null ? '' : String(reply.body),
            };
            if (reply?.isAnswer) entry.isAnswer = true;
            return entry;
          });
        }
        item.replyTotalCount = Number(node?.replies?.totalCount ?? 0);
      }
      return item;
    }),
    pageInfo: pageInfoOutput(comments),
    totalCount: Number(comments.totalCount ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * list_discussion_categories
 * ------------------------------------------------------------------ */

/** List the discussion categories defined by a repository. */
async function listDiscussionCategories(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = optionalString(args, 'repo') ?? DEFAULT_DISCUSSION_REPO;

  const query = `query($owner: String!, $repo: String!, $first: Int!) {
  repository(owner: $owner, name: $repo) {
    discussionCategories(first: $first) {
      nodes { id name }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      totalCount
    }
  }
}`;

  const data = await ctx.client.graphql(
    query,
    { owner, repo, first: DISCUSSION_CATEGORY_PAGE_SIZE },
    { signal: ctx.signal },
  );
  const categories = data?.repository?.discussionCategories ?? {};
  const nodes = Array.isArray(categories.nodes) ? categories.nodes : [];

  return {
    categories: nodes.map((node) => ({
      id: node?.id == null ? '' : String(node.id),
      name: node?.name == null ? '' : String(node.name),
    })),
    pageInfo: pageInfoOutput(categories),
    totalCount: Number(categories.totalCount ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * discussion_comment_write
 * ------------------------------------------------------------------ */

const COMMENT_WRITE_METHODS = ['add', 'reply', 'update', 'delete', 'mark_answer', 'unmark_answer'];

const ADD_COMMENT_MUTATION = `mutation($input: AddDiscussionCommentInput!) {
  addDiscussionComment(input: $input) { comment { id url } }
}`;
const UPDATE_COMMENT_MUTATION = `mutation($input: UpdateDiscussionCommentInput!) {
  updateDiscussionComment(input: $input) { comment { id url } }
}`;
const DELETE_COMMENT_MUTATION = `mutation($input: DeleteDiscussionCommentInput!) {
  deleteDiscussionComment(input: $input) { comment { id url } }
}`;
const MARK_ANSWER_MUTATION = `mutation($input: MarkDiscussionCommentAsAnswerInput!) {
  markDiscussionCommentAsAnswer(input: $input) { discussion { id url } }
}`;
const UNMARK_ANSWER_MUTATION = `mutation($input: UnmarkDiscussionCommentAsAnswerInput!) {
  unmarkDiscussionCommentAsAnswer(input: $input) { discussion { id url } }
}`;

/** Add a top-level discussion comment. */
async function addDiscussionComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const discussionNumber = requireInt(args, 'discussionNumber');
  const body = requireString(args, 'body');

  const discussionId = await discussionNodeId(ctx, owner, repo, discussionNumber);
  const data = await ctx.client.graphql(ADD_COMMENT_MUTATION, { input: { discussionId, body } }, { signal: ctx.signal });
  const comment = data?.addDiscussionComment?.comment;
  return {
    id: comment?.id == null ? '' : String(comment.id),
    url: comment?.url == null ? '' : String(comment.url),
  };
}

/** Reply to a top-level discussion comment (GitHub allows one nesting level). */
async function replyToDiscussionComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const discussionNumber = requireInt(args, 'discussionNumber');
  const body = requireString(args, 'body');

  const rawCommentNodeID = args?.commentNodeID;
  const commentNodeID = optionalString(args, 'commentNodeID');
  if (commentNodeID === undefined) {
    if (rawCommentNodeID === undefined) fail('missing required argument: commentNodeID');
    fail('commentNodeID cannot be blank');
  }

  // The GitHub API silently ignores an invalid replyToId and creates a top-level
  // comment instead, so validate the node up front for a clear failure.
  const nodeQuery = `query($replyToID: ID!) {
  node(id: $replyToID) { ... on DiscussionComment { id discussion { id } } }
}`;
  let node;
  try {
    const data = await ctx.client.graphql(nodeQuery, { replyToID: commentNodeID }, { signal: ctx.signal });
    node = data?.node;
  } catch (error) {
    fail(`failed to validate commentNodeID: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resolvedCommentID = node?.id;
  if (resolvedCommentID == null || String(resolvedCommentID) === '') {
    fail(`commentNodeID ${JSON.stringify(commentNodeID)} does not resolve to a valid discussion comment`);
  }

  const parentDiscussionID = node?.discussion?.id;
  const discussionId = await discussionNodeId(ctx, owner, repo, discussionNumber);
  if (String(parentDiscussionID ?? '') !== String(discussionId ?? '')) {
    fail(
      `commentNodeID ${JSON.stringify(commentNodeID)} does not belong to discussion #${discussionNumber} in ${owner}/${repo}`,
    );
  }

  const data = await ctx.client.graphql(
    ADD_COMMENT_MUTATION,
    { input: { discussionId: parentDiscussionID, body, replyToId: commentNodeID } },
    { signal: ctx.signal },
  );
  const comment = data?.addDiscussionComment?.comment;
  return {
    id: comment?.id == null ? '' : String(comment.id),
    url: comment?.url == null ? '' : String(comment.url),
  };
}

/** Update the body of a discussion comment. */
async function updateDiscussionComment(args, ctx) {
  const commentNodeID = requireString(args, 'commentNodeID');
  const body = requireString(args, 'body');

  const data = await ctx.client.graphql(
    UPDATE_COMMENT_MUTATION,
    { input: { commentId: commentNodeID, body } },
    { signal: ctx.signal },
  );
  const comment = data?.updateDiscussionComment?.comment;
  return {
    id: comment?.id == null ? '' : String(comment.id),
    url: comment?.url == null ? '' : String(comment.url),
  };
}

/** Delete a discussion comment. */
async function deleteDiscussionComment(args, ctx) {
  const commentNodeID = requireString(args, 'commentNodeID');

  const data = await ctx.client.graphql(DELETE_COMMENT_MUTATION, { input: { id: commentNodeID } }, { signal: ctx.signal });
  const comment = data?.deleteDiscussionComment?.comment;
  return {
    id: comment?.id == null ? '' : String(comment.id),
    url: comment?.url == null ? '' : String(comment.url),
  };
}

/** Mark a discussion comment as the accepted answer. */
async function markDiscussionCommentAsAnswer(args, ctx) {
  const commentNodeID = requireString(args, 'commentNodeID');

  const data = await ctx.client.graphql(MARK_ANSWER_MUTATION, { input: { id: commentNodeID } }, { signal: ctx.signal });
  const discussion = data?.markDiscussionCommentAsAnswer?.discussion;
  return {
    discussionID: discussion?.id == null ? '' : String(discussion.id),
    discussionURL: discussion?.url == null ? '' : String(discussion.url),
  };
}

/** Remove the accepted-answer mark from a discussion comment. */
async function unmarkDiscussionCommentAsAnswer(args, ctx) {
  const commentNodeID = requireString(args, 'commentNodeID');

  const data = await ctx.client.graphql(UNMARK_ANSWER_MUTATION, { input: { id: commentNodeID } }, { signal: ctx.signal });
  const discussion = data?.unmarkDiscussionCommentAsAnswer?.discussion;
  return {
    discussionID: discussion?.id == null ? '' : String(discussion.id),
    discussionURL: discussion?.url == null ? '' : String(discussion.url),
  };
}

/** Add, reply to, update, delete, mark or unmark a discussion comment. */
async function discussionCommentWrite(args, ctx) {
  const method = requireString(args, 'method');
  if (!COMMENT_WRITE_METHODS.includes(method)) {
    fail("invalid method, must be one of: 'add', 'reply', 'update', 'delete', 'mark_answer', 'unmark_answer'");
  }

  switch (method) {
    case 'add':
      return addDiscussionComment(args, ctx);
    case 'reply':
      return replyToDiscussionComment(args, ctx);
    case 'update':
      return updateDiscussionComment(args, ctx);
    case 'delete':
      return deleteDiscussionComment(args, ctx);
    case 'mark_answer':
      return markDiscussionCommentAsAnswer(args, ctx);
    default:
      return unmarkDiscussionCommentAsAnswer(args, ctx);
  }
}

export default {
  discussion_comment_write: discussionCommentWrite,
  get_discussion: getDiscussion,
  get_discussion_comments: getDiscussionComments,
  list_discussion_categories: listDiscussionCategories,
  list_discussions: listDiscussions,
};

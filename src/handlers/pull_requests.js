/**
 * Pull request handlers.
 *
 * Tools:
 *   - pull_request_read
 *   - list_pull_requests
 *   - search_pull_requests
 *   - merge_pull_request
 *   - update_pull_request_branch
 *   - create_pull_request
 *   - update_pull_request
 *   - pull_request_review_write
 *   - add_comment_to_pending_review
 *   - add_reply_to_pull_request_comment
 *
 * Ported from the upstream Go server:
 *   pkg/github/pullrequests.go                    (all ten tools)
 *   pkg/github/minimal_types.go                   (Minimal* output shapes)
 *   pkg/github/consolidated_pull_request_types.go (output unions)
 *   pkg/github/search_utils.go                    (search query preparation)
 *   pkg/github/issues.go                          (search result projection)
 *   pkg/github/params.go                          (pagination defaults)
 *
 * NOTE: the upstream server runs every title/body through `sanitize.Content`
 * (invisible-character stripping plus HTML-to-text) before returning it. This
 * port returns the API payload verbatim, matching the other handlers in this
 * plugin.
 */

import {
  asArray,
  defined,
  fail,
  optionalBoolean,
  optionalString,
  paginationQuery,
  requireString,
  seg,
  toPositiveInt,
} from '../util.js';

/** GraphQL document used by `pull_request_read` method `get_review_comments`. */
const REVIEW_THREADS_QUERY = `query($owner: String!, $repo: String!, $prNum: Int!, $first: Int!, $after: String, $commentsPerThread: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNum) {
      reviewThreads(first: $first, after: $after) {
        nodes {
          id
          isResolved
          isOutdated
          isCollapsed
          comments(first: $commentsPerThread) {
            nodes {
              id
              body
              path
              line
              originalLine
              startLine
              originalStartLine
              author { login }
              createdAt
              updatedAt
              url
            }
            totalCount
          }
        }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        totalCount
      }
    }
  }
}`;

/** GraphQL document resolving a pull request's global node id. */
const PULL_REQUEST_ID_QUERY = `query($owner: String!, $repo: String!, $prNum: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNum) { id }
  }
}`;

/** GraphQL document resolving the pull request id plus its draft state. */
const PULL_REQUEST_DRAFT_QUERY = `query($owner: String!, $repo: String!, $prNum: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $prNum) { id isDraft }
  }
}`;

const CONVERT_TO_DRAFT_MUTATION = `mutation($input: ConvertPullRequestToDraftInput!) {
  convertPullRequestToDraft(input: $input) { pullRequest { id } }
}`;

const MARK_READY_FOR_REVIEW_MUTATION = `mutation($input: MarkPullRequestReadyForReviewInput!) {
  markPullRequestReadyForReview(input: $input) { pullRequest { id } }
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

/** Pending reviews authored by the viewer, used by the pending-review methods. */
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

/** Fields accepted by the `fields` argument of list_pull_requests. */
const LIST_PULL_REQUEST_FIELDS = [
  'number',
  'title',
  'body',
  'state',
  'draft',
  'merged',
  'mergeable_state',
  'html_url',
  'user',
  'labels',
  'assignees',
  'requested_reviewers',
  'merged_by',
  'head',
  'base',
  'additions',
  'deletions',
  'changed_files',
  'commits',
  'comments',
  'created_at',
  'updated_at',
  'closed_at',
  'merged_at',
  'milestone',
];

/** Fields accepted by the `fields` argument of search_pull_requests. */
const SEARCH_PULL_REQUEST_FIELDS = [
  'number',
  'title',
  'body',
  'state',
  'state_reason',
  'draft',
  'locked',
  'html_url',
  'user',
  'author_association',
  'labels',
  'assignee',
  'assignees',
  'milestone',
  'comments',
  'reactions',
  'created_at',
  'updated_at',
  'closed_at',
  'closed_by',
  'pull_request',
  'repository_url',
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

/** MinimalUser, mirroring convertToMinimalUser. */
function minimalUser(user) {
  if (!user || typeof user !== 'object') return undefined;
  return defined({
    login: user.login,
    id: user.id,
    profile_url: nonEmpty(user.html_url),
    avatar_url: nonEmpty(user.avatar_url),
  });
}

/** MinimalPRBranch, mirroring convertToMinimalPRBranch. */
function minimalPRBranch(branch) {
  if (!branch || typeof branch !== 'object') return undefined;
  return defined({
    ref: branch.ref,
    sha: branch.sha,
    repo: branch.repo
      ? defined({
          full_name: branch.repo.full_name,
          description: nonEmpty(branch.repo.description),
        })
      : undefined,
  });
}

/** MinimalPullRequest, mirroring convertToMinimalPullRequest. */
function minimalPullRequest(pr) {
  if (!pr || typeof pr !== 'object') return {};
  const labels = asArray(pr.labels)
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string' && name !== '');
  const assignees = asArray(pr.assignees).map((user) => nonEmpty(user?.login)).filter(Boolean);
  const requestedReviewers = asArray(pr.requested_reviewers)
    .map((user) => nonEmpty(user?.login))
    .filter(Boolean);
  return defined({
    number: pr.number,
    title: pr.title,
    body: nonEmpty(pr.body),
    state: pr.state,
    draft: Boolean(pr.draft),
    merged: Boolean(pr.merged),
    mergeable_state: nonEmpty(pr.mergeable_state),
    html_url: pr.html_url,
    user: minimalUser(pr.user),
    labels: labels.length > 0 ? labels : undefined,
    assignees: assignees.length > 0 ? assignees : undefined,
    requested_reviewers: requestedReviewers.length > 0 ? requestedReviewers : undefined,
    merged_by: nonEmpty(pr.merged_by?.login),
    head: minimalPRBranch(pr.head),
    base: minimalPRBranch(pr.base),
    additions: pr.additions || undefined,
    deletions: pr.deletions || undefined,
    changed_files: pr.changed_files || undefined,
    commits: pr.commits || undefined,
    comments: pr.comments || undefined,
    created_at: nonEmpty(pr.created_at),
    updated_at: nonEmpty(pr.updated_at),
    closed_at: nonEmpty(pr.closed_at),
    merged_at: nonEmpty(pr.merged_at),
    milestone: nonEmpty(pr.milestone?.title),
  });
}

/** MinimalCombinedStatus, mirroring convertToMinimalCombinedStatus. */
function minimalCombinedStatus(status) {
  const source = status && typeof status === 'object' ? status : {};
  return {
    state: source.state ?? '',
    sha: source.sha ?? '',
    total_count: source.total_count ?? 0,
    statuses: asArray(source.statuses).map((item) =>
      defined({
        state: item?.state,
        context: item?.context,
        description: nonEmpty(item?.description),
        target_url: nonEmpty(item?.target_url),
        created_at: nonEmpty(item?.created_at),
        updated_at: nonEmpty(item?.updated_at),
      }),
    ),
  };
}

/** MinimalCheckRun, mirroring convertToMinimalCheckRun. */
function minimalCheckRun(run) {
  if (!run || typeof run !== 'object') return {};
  return defined({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: nonEmpty(run.conclusion),
    html_url: nonEmpty(run.html_url),
    details_url: nonEmpty(run.details_url),
    started_at: nonEmpty(run.started_at),
    completed_at: nonEmpty(run.completed_at),
  });
}

/** MinimalPRFile, mirroring convertToMinimalPRFiles. */
function minimalPRFile(file) {
  if (!file || typeof file !== 'object') return {};
  return defined({
    filename: file.filename,
    status: nonEmpty(file.status),
    additions: file.additions || undefined,
    deletions: file.deletions || undefined,
    changes: file.changes || undefined,
    patch: nonEmpty(file.patch),
    previous_filename: nonEmpty(file.previous_filename),
  });
}

/** MinimalPullRequestCommit, mirroring convertToMinimalPullRequestCommits. */
function minimalPullRequestCommit(commit) {
  if (!commit || typeof commit !== 'object') return undefined;
  const author = commit.commit?.author;
  return defined({
    sha: commit.sha,
    html_url: nonEmpty(commit.html_url),
    message: nonEmpty(commit.commit?.message),
    author: author
      ? defined({
          name: nonEmpty(author.name),
          email: nonEmpty(author.email),
          date: nonEmpty(author.date),
        })
      : undefined,
  });
}

/** MinimalPullRequestReview, mirroring convertToMinimalPullRequestReview. */
function minimalPullRequestReview(review) {
  if (!review || typeof review !== 'object') return {};
  return defined({
    id: review.id,
    state: review.state,
    body: nonEmpty(review.body),
    html_url: review.html_url,
    user: minimalUser(review.user),
    commit_id: nonEmpty(review.commit_id),
    submitted_at: nonEmpty(review.submitted_at),
    author_association: nonEmpty(review.author_association),
  });
}

/** MinimalReactions, mirroring convertToMinimalReactions. */
function minimalReactions(reactions) {
  if (!reactions || typeof reactions !== 'object') return undefined;
  return {
    total_count: reactions.total_count ?? 0,
    '+1': reactions['+1'] ?? 0,
    '-1': reactions['-1'] ?? 0,
    laugh: reactions.laugh ?? 0,
    confused: reactions.confused ?? 0,
    heart: reactions.heart ?? 0,
    hooray: reactions.hooray ?? 0,
    rocket: reactions.rocket ?? 0,
    eyes: reactions.eyes ?? 0,
  };
}

/** IssueReadCommentOutput, mirroring issueCommentOutputs (user = {login, id}). */
function issueReadComment(comment) {
  if (!comment || typeof comment !== 'object') return {};
  return defined({
    id: comment.id,
    body: nonEmpty(comment.body),
    html_url: nonEmpty(comment.html_url),
    user: comment.user ? defined({ login: comment.user.login, id: comment.user.id }) : undefined,
    author_association: nonEmpty(comment.author_association),
    reactions: minimalReactions(comment.reactions),
    created_at: nonEmpty(comment.created_at),
    updated_at: nonEmpty(comment.updated_at),
  });
}

/** MinimalReviewComment, mirroring convertToMinimalReviewComment. */
function minimalReviewComment(comment) {
  if (!comment || typeof comment !== 'object') return {};
  return defined({
    body: nonEmpty(comment.body),
    path: comment.path ?? '',
    line: comment.line ?? undefined,
    original_line: comment.originalLine ?? undefined,
    start_line: comment.startLine ?? undefined,
    original_start_line: comment.originalStartLine ?? undefined,
    author: nonEmpty(comment.author?.login),
    created_at: nonEmpty(comment.createdAt),
    updated_at: nonEmpty(comment.updatedAt),
    html_url: comment.url,
  });
}

/** MinimalReviewThreadsResponse, mirroring convertToMinimalReviewThreadsResponse. */
function minimalReviewThreadsResponse(data) {
  const threads = data?.repository?.pullRequest?.reviewThreads;
  const pageInfo = threads?.pageInfo;
  return {
    review_threads: asArray(threads?.nodes).map((thread) =>
      defined({
        id: thread?.id == null ? undefined : String(thread.id),
        is_resolved: Boolean(thread?.isResolved),
        is_outdated: Boolean(thread?.isOutdated),
        is_collapsed: Boolean(thread?.isCollapsed),
        comments: asArray(thread?.comments?.nodes).map(minimalReviewComment),
        total_count: thread?.comments?.totalCount ?? 0,
      }),
    ),
    totalCount: threads?.totalCount ?? 0,
    pageInfo: {
      hasNextPage: Boolean(pageInfo?.hasNextPage),
      hasPreviousPage: Boolean(pageInfo?.hasPreviousPage),
      ...(nonEmpty(pageInfo?.startCursor) ? { startCursor: pageInfo.startCursor } : {}),
      ...(nonEmpty(pageInfo?.endCursor) ? { endCursor: pageInfo.endCursor } : {}),
    },
  };
}

/**
 * The `fields` argument as an array of field names (empty = every field).
 * Upstream matches each name against the marshalled item, so a name outside the
 * documented enum matches nothing rather than failing the call.
 */
function requestedFields(args, allowed) {
  const raw = args?.fields;
  if (raw === undefined || raw === null) return [];
  const list = asArray(raw).filter((name) => typeof name === 'string' && name !== '');
  if (list.length === 0) return [];
  return list.some((name) => allowed.includes(name))
    ? list.filter((name) => allowed.includes(name))
    : list;
}

/** ListPullRequestOutput, mirroring structuredListPullRequestsOutput. */
function listPullRequestOutput(pr, fields) {
  const selected = (name) => fields.length === 0 || fields.includes(name);
  const item = {};
  if (selected('number')) item.number = pr?.number;
  if (selected('title')) item.title = pr?.title;
  if (selected('body') && nonEmpty(pr?.body)) item.body = pr.body;
  if (selected('state')) item.state = pr?.state;
  if (selected('draft')) item.draft = Boolean(pr?.draft);
  if (selected('merged')) item.merged = Boolean(pr?.merged);
  if (selected('mergeable_state') && nonEmpty(pr?.mergeable_state)) item.mergeable_state = pr.mergeable_state;
  if (selected('html_url')) item.html_url = pr?.html_url;
  if (selected('user') && pr?.user) item.user = minimalUser(pr.user);
  if (selected('labels') && asArray(pr?.labels).length > 0) {
    item.labels = asArray(pr.labels)
      .map((label) => (typeof label === 'string' ? label : label?.name))
      .filter((name) => typeof name === 'string' && name !== '');
  }
  if (selected('assignees') && asArray(pr?.assignees).length > 0) {
    item.assignees = asArray(pr.assignees).map((user) => user?.login).filter(Boolean);
  }
  if (selected('requested_reviewers') && asArray(pr?.requested_reviewers).length > 0) {
    item.requested_reviewers = asArray(pr.requested_reviewers).map((user) => user?.login).filter(Boolean);
  }
  if (selected('merged_by') && nonEmpty(pr?.merged_by?.login)) item.merged_by = pr.merged_by.login;
  if (selected('head') && pr?.head) item.head = minimalPRBranch(pr.head);
  if (selected('base') && pr?.base) item.base = minimalPRBranch(pr.base);
  if (selected('additions') && pr?.additions) item.additions = pr.additions;
  if (selected('deletions') && pr?.deletions) item.deletions = pr.deletions;
  if (selected('changed_files') && pr?.changed_files) item.changed_files = pr.changed_files;
  if (selected('commits') && pr?.commits) item.commits = pr.commits;
  if (selected('comments') && pr?.comments) item.comments = pr.comments;
  if (selected('created_at') && nonEmpty(pr?.created_at)) item.created_at = pr.created_at;
  if (selected('updated_at') && nonEmpty(pr?.updated_at)) item.updated_at = pr.updated_at;
  if (selected('closed_at') && nonEmpty(pr?.closed_at)) item.closed_at = pr.closed_at;
  if (selected('merged_at') && nonEmpty(pr?.merged_at)) item.merged_at = pr.merged_at;
  if (selected('milestone') && nonEmpty(pr?.milestone?.title)) item.milestone = pr.milestone.title;
  return item;
}

/** SearchIssueOutputItem, mirroring issues.go's structuredSearchIssuesOutput. */
function searchIssueOutputItem(issue, fields) {
  if (!issue || typeof issue !== 'object') return {};
  const selected = (name) => fields.length === 0 || fields.includes(name);
  const item = {};
  if (selected('number')) item.number = issue.number;
  if (selected('title')) item.title = issue.title;
  if (selected('body') && issue.body != null) item.body = issue.body;
  if (selected('state') && issue.state != null) item.state = issue.state;
  if (selected('state_reason') && issue.state_reason != null) item.state_reason = issue.state_reason;
  if (selected('draft') && issue.draft != null) item.draft = issue.draft;
  if (selected('locked') && issue.locked != null) item.locked = issue.locked;
  if (selected('html_url') && issue.html_url != null) item.html_url = issue.html_url;
  if (selected('user') && issue.user != null) item.user = minimalUser(issue.user);
  if (selected('author_association') && issue.author_association != null) {
    item.author_association = issue.author_association;
  }
  if (selected('labels') && issue.labels != null) {
    item.labels = asArray(issue.labels)
      .map((label) => (typeof label === 'string' ? label : label?.name))
      .filter((name) => typeof name === 'string' && name !== '');
  }
  if (selected('assignee') && issue.assignee != null) item.assignee = issue.assignee.login;
  if (selected('assignees') && issue.assignees != null) {
    item.assignees = asArray(issue.assignees).map((user) => user?.login).filter(Boolean);
  }
  if (selected('milestone') && issue.milestone != null) item.milestone = issue.milestone.title;
  if (selected('comments') && issue.comments != null) item.comments = issue.comments;
  if (selected('reactions') && issue.reactions != null) item.reactions = minimalReactions(issue.reactions);
  if (selected('created_at') && issue.created_at != null) item.created_at = issue.created_at;
  if (selected('updated_at') && issue.updated_at != null) item.updated_at = issue.updated_at;
  if (selected('closed_at') && issue.closed_at != null) item.closed_at = issue.closed_at;
  if (selected('closed_by') && issue.closed_by != null) item.closed_by = issue.closed_by.login;
  if (selected('type') && issue.type != null) item.type = issue.type.name;
  if (selected('repository_url') && issue.repository_url != null) item.repository_url = issue.repository_url;
  if (selected('pull_request') && issue.pull_request != null) {
    item.pull_request = defined({
      url: issue.pull_request.url,
      html_url: issue.pull_request.html_url,
      diff_url: issue.pull_request.diff_url,
      patch_url: issue.pull_request.patch_url,
    });
  }
  // Upstream only sets field_values when the raw issue carries them; search
  // results on this path never do.
  if (selected('field_values') && issue.field_values != null) item.field_values = issue.field_values;
  return item;
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

/** POST the requested reviewers for a pull request. */
async function requestReviewers(ctx, owner, repo, pullNumber, reviewers) {
  const { users, teams } = splitPullRequestReviewers(reviewers);
  const body = defined({ reviewers: users, team_reviewers: teams });
  const response = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}/requested_reviewers`,
    body,
    { signal: ctx.signal },
  );
  return { id: String(response?.id ?? ''), url: response?.html_url };
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
    { owner, repo, prNum: pullNumber },
    { signal: ctx.signal },
  );
  return data?.repository?.pullRequest?.id ?? null;
}

/** `pull_request_read` method `get_review_comments` (GraphQL review threads). */
async function reviewThreads(owner, repo, pullNumber, args, ctx) {
  const perPage = toPositiveInt(args?.perPage, 30);
  if (perPage > 100) fail(`perPage value ${perPage} exceeds maximum of 100`);
  const after = optionalString(args, 'after');
  const data = await ctx.client.graphql(
    REVIEW_THREADS_QUERY,
    { owner, repo, prNum: pullNumber, first: perPage, after: after ?? null, commentsPerThread: 100 },
    { signal: ctx.signal },
  );
  return minimalReviewThreadsResponse(data);
}

/**
 * Read a pull request and its derived collections.
 * `method` selects the sub-operation.
 */
async function pullRequestRead(args, ctx) {
  const method = requireString(args, 'method');
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const { page, per_page: perPage } = paginationQuery(args);
  const pullPath = `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}`;
  const commitsPath = `/repos/${seg(owner)}/${seg(repo)}/commits`;

  switch (method) {
    case 'get':
      return minimalPullRequest(await ctx.client.get(pullPath, { signal: ctx.signal }));

    case 'get_diff': {
      const diff = await ctx.client.getText(pullPath, {
        headers: { accept: 'application/vnd.github.diff' },
        signal: ctx.signal,
      });
      return { diff };
    }

    case 'get_status': {
      const pr = await ctx.client.get(pullPath, { signal: ctx.signal });
      const status = await ctx.client.get(`${commitsPath}/${seg(pr?.head?.sha ?? '')}/status`, {
        signal: ctx.signal,
      });
      return minimalCombinedStatus(status);
    }

    case 'get_files': {
      const files = await ctx.client.get(`${pullPath}/files`, {
        query: { page, per_page: perPage },
        signal: ctx.signal,
      });
      return { items: asArray(files).map(minimalPRFile) };
    }

    case 'get_commits': {
      const commits = await ctx.client.get(`${pullPath}/commits`, {
        query: { page, per_page: perPage },
        signal: ctx.signal,
      });
      return { items: asArray(commits).map(minimalPullRequestCommit).filter(Boolean) };
    }

    case 'get_reviews': {
      const reviews = await ctx.client.get(`${pullPath}/reviews`, {
        query: { page, per_page: perPage },
        signal: ctx.signal,
      });
      return { items: asArray(reviews).map(minimalPullRequestReview) };
    }

    case 'get_comments': {
      const comments = await ctx.client.get(
        `/repos/${seg(owner)}/${seg(repo)}/issues/${pullNumber}/comments`,
        { query: { page, per_page: perPage }, signal: ctx.signal },
      );
      return { items: asArray(comments).map(issueReadComment) };
    }

    case 'get_review_comments':
      return reviewThreads(owner, repo, pullNumber, args, ctx);

    case 'get_check_runs': {
      const pr = await ctx.client.get(pullPath, { signal: ctx.signal });
      const runs = await ctx.client.get(`${commitsPath}/${seg(pr?.head?.sha ?? '')}/check-runs`, {
        query: { page, per_page: perPage },
        signal: ctx.signal,
      });
      return {
        total_count: runs?.total_count ?? 0,
        check_runs: asArray(runs?.check_runs).map(minimalCheckRun),
      };
    }

    default:
      return fail(`unknown method: ${method}`);
  }
}

/**
 * List pull requests in a repository, optionally filtered by state/head/base.
 */
async function listPullRequests(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const fields = requestedFields(args, LIST_PULL_REQUEST_FIELDS);
  const { page, per_page: perPage } = paginationQuery(args);
  const query = defined({
    state: optionalString(args, 'state'),
    head: optionalString(args, 'head'),
    base: optionalString(args, 'base'),
    sort: optionalString(args, 'sort'),
    direction: optionalString(args, 'direction'),
    page,
    per_page: perPage,
  });
  const pulls = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/pulls`, {
    query,
    signal: ctx.signal,
  });
  // `listPullRequestOutput` projects a RAW PullRequest — it mirrors upstream's
  // structuredListPullRequestsOutput. Feeding it the MinimalPullRequest conversion
  // makes every nested accessor (user / assignees / requested_reviewers / merged_by /
  // milestone) resolve to undefined and silently drops those fields.
  return { items: asArray(pulls).map((pr) => listPullRequestOutput(pr, fields)) };
}

/**
 * Search pull requests with GitHub's search syntax.
 */
async function searchPullRequests(args, ctx) {
  const query = requireString(args, 'query');
  const owner = optionalString(args, 'owner');
  const repo = optionalString(args, 'repo');
  const fields = requestedFields(args, SEARCH_PULL_REQUEST_FIELDS);
  const { page, per_page: perPage } = paginationQuery(args);

  let q = query;
  if (!/(^|\s|\W)is:pr($|\s|\W)/.test(q)) q = `is:pr ${q}`;
  if (owner && repo && !/(^|\s|\W)repo:\S+/.test(q)) q = `repo:${owner}/${repo} ${q}`;

  const searchQuery = defined({
    q,
    sort: optionalString(args, 'sort'),
    order: optionalString(args, 'order'),
    page,
    advanced_search: q.includes('field.') ? true : undefined,
  });

  const result = await ctx.client.search('/search/issues', {
    query: searchQuery,
    perPage,
    signal: ctx.signal,
  });
  return {
    total_count: result?.total_count ?? 0,
    incomplete_results: Boolean(result?.incomplete_results),
    items: asArray(result?.items).map((issue) => searchIssueOutputItem(issue, fields)),
  };
}

/**
 * Merge a pull request.
 */
async function mergePullRequest(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const body = defined({
    commit_title: optionalString(args, 'commit_title'),
    commit_message: optionalString(args, 'commit_message'),
    sha: optionalString(args, 'expectedHeadSha'),
    merge_method: optionalString(args, 'merge_method'),
  });
  const result = await ctx.client.put(
    `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}/merge`,
    body,
    { signal: ctx.signal },
  );
  if (!result || typeof result !== 'object') return {};
  return defined({
    sha: nonEmpty(result.sha),
    merged: typeof result.merged === 'boolean' ? result.merged : undefined,
    message: nonEmpty(result.message),
  });
}

/**
 * Update a pull request branch with the latest changes from the base branch.
 */
async function updatePullRequestBranch(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const body = defined({ expected_head_sha: optionalString(args, 'expectedHeadSha') });
  const result = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}/update-branch`,
    body,
    { signal: ctx.signal },
  );
  return defined({ message: nonEmpty(result?.message) });
}

/**
 * Create a pull request, optionally requesting reviewers.
 */
async function createPullRequest(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const title = requireString(args, 'title');
  const head = requireString(args, 'head');
  const base = requireString(args, 'base');
  const body = defined({
    title,
    head,
    base,
    body: optionalString(args, 'body'),
    draft: optionalBoolean(args, 'draft', false),
    maintainer_can_modify: optionalBoolean(args, 'maintainer_can_modify', false),
  });
  const pr = await ctx.client.post(`/repos/${seg(owner)}/${seg(repo)}/pulls`, body, {
    signal: ctx.signal,
  });
  const reviewers = asArray(args?.reviewers).filter((value) => typeof value === 'string' && value !== '');
  if (reviewers.length > 0 && pr?.number != null) {
    await requestReviewers(ctx, owner, repo, pr.number, reviewers);
  }
  return defined({ id: String(pr?.id ?? ''), html_url: nonEmpty(pr?.html_url) });
}

/**
 * Update an existing pull request (title, body, state, base, draft state, reviewers).
 */
async function updatePullRequest(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const pullPath = `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}`;

  const title = optionalString(args, 'title');
  const body = optionalString(args, 'body');
  const state = optionalString(args, 'state');
  const base = optionalString(args, 'base');
  const maintainerCanModify = optionalBoolean(args, 'maintainer_can_modify', undefined);
  const draft = optionalBoolean(args, 'draft', undefined);
  const reviewers = asArray(args?.reviewers).filter((value) => typeof value === 'string' && value !== '');

  const patch = defined({
    title,
    body,
    state,
    base: base === undefined ? undefined : { ref: base },
    maintainer_can_modify: maintainerCanModify,
  });

  if (Object.keys(patch).length > 0) {
    await ctx.client.patch(pullPath, patch, { signal: ctx.signal });
  }

  if (draft !== undefined) {
    const data = await ctx.client.graphql(
      PULL_REQUEST_DRAFT_QUERY,
      { owner, repo, prNum: pullNumber },
      { signal: ctx.signal },
    );
    const node = data?.repository?.pullRequest;
    if (node?.id == null) fail('failed to get pull request');
    if (Boolean(node.isDraft) !== draft) {
      const mutation = draft ? CONVERT_TO_DRAFT_MUTATION : MARK_READY_FOR_REVIEW_MUTATION;
      await ctx.client.graphql(mutation, { input: { pullRequestId: node.id } }, { signal: ctx.signal });
    }
  }

  if (reviewers.length > 0) {
    await requestReviewers(ctx, owner, repo, pullNumber, reviewers);
  }

  if (Object.keys(patch).length === 0 && draft === undefined && reviewers.length === 0) {
    fail('No update parameters provided.');
  }

  const pr = await ctx.client.get(pullPath, { signal: ctx.signal });
  return defined({ id: String(pr?.id ?? ''), html_url: nonEmpty(pr?.html_url) });
}

/** `pull_request_review_write` method `create`. */
async function createReview(ctx, owner, repo, pullNumber, body, event, commitID) {
  const pullRequestId = await pullRequestNodeId(ctx, owner, repo, pullNumber);
  const input = defined({
    pullRequestId,
    commitOID: nonEmpty(commitID),
    event: nonEmpty(event),
    body: nonEmpty(event) ? (body ?? '') : undefined,
  });
  await ctx.client.graphql(ADD_PULL_REQUEST_REVIEW_MUTATION, { input }, { signal: ctx.signal });
  return event ? 'pull request review submitted successfully' : 'pending pull request created';
}

/** `pull_request_review_write` method `submit_pending`. */
async function submitPendingReview(ctx, owner, repo, pullNumber, body, event) {
  const reviewId = await pendingReviewId(ctx, owner, repo, pullNumber);
  await ctx.client.graphql(
    SUBMIT_PULL_REQUEST_REVIEW_MUTATION,
    { input: { pullRequestReviewId: reviewId, event, body: body ?? '' } },
    { signal: ctx.signal },
  );
  return 'pending pull request review successfully submitted';
}

/** `pull_request_review_write` method `delete_pending`. */
async function deletePendingReview(ctx, owner, repo, pullNumber) {
  const reviewId = await pendingReviewId(ctx, owner, repo, pullNumber);
  await ctx.client.graphql(
    DELETE_PULL_REQUEST_REVIEW_MUTATION,
    { input: { pullRequestReviewId: reviewId } },
    { signal: ctx.signal },
  );
  return 'pending pull request review successfully deleted';
}

/**
 * Create, submit or delete a pending pull request review, or resolve a review thread.
 */
async function pullRequestReviewWrite(args, ctx) {
  const method = requireString(args, 'method');
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const pullNumber = requirePositiveInt(args, 'pullNumber');
  const body = optionalString(args, 'body');
  const event = optionalString(args, 'event');
  const commitID = optionalString(args, 'commitID');
  const threadId = optionalString(args, 'threadId');
  const resolutionReason = optionalString(args, 'resolutionReason');

  switch (method) {
    case 'create':
      return { message: await createReview(ctx, owner, repo, pullNumber, body, event, commitID) };

    case 'submit_pending':
      return { message: await submitPendingReview(ctx, owner, repo, pullNumber, body, event) };

    case 'delete_pending':
      return { message: await deletePendingReview(ctx, owner, repo, pullNumber) };

    case 'resolve_thread':
    case 'unresolve_thread': {
      if (!threadId) fail('threadId is required for resolve_thread and unresolve_thread methods');
      if (method === 'resolve_thread') {
        await ctx.client.graphql(
          RESOLVE_REVIEW_THREAD_MUTATION,
          { input: defined({ threadId, resolutionReason }) },
          { signal: ctx.signal },
        );
        return { message: 'review thread resolved successfully' };
      }
      await ctx.client.graphql(
        UNRESOLVE_REVIEW_THREAD_MUTATION,
        { input: { threadId } },
        { signal: ctx.signal },
      );
      return { message: 'review thread unresolved successfully' };
    }

    default:
      return fail(`unknown method: ${method}`);
  }
}

/**
 * Add a review comment to the requester's latest pending pull request review.
 */
async function addCommentToPendingReview(args, ctx) {
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
 * Reply to an existing pull request review comment, optionally adding a reaction.
 */
async function addReplyToPullRequestComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requirePositiveInt(args, 'commentId');
  const hasBody = args?.body !== undefined && args?.body !== null;
  const hasReaction = args?.reaction !== undefined && args?.reaction !== null;
  if (!hasBody && !hasReaction) fail('at least one of body or reaction is required');
  if (hasBody && String(args.body) === '') fail('body cannot be empty when provided');
  if (hasReaction && String(args.reaction) === '') fail('reaction cannot be empty when provided');

  const reaction = hasReaction ? String(args.reaction) : undefined;
  const body = hasBody ? String(args.body) : undefined;

  let reactionResponse;
  if (reaction !== undefined) {
    reactionResponse = await ctx.client.post(
      `/repos/${seg(owner)}/${seg(repo)}/pulls/comments/${commentId}/reactions`,
      { content: reaction },
      { signal: ctx.signal },
    );
  }

  let commentResponse;
  if (body !== undefined) {
    const pullNumber = requirePositiveInt(args, 'pullNumber');
    commentResponse = await ctx.client.post(
      `/repos/${seg(owner)}/${seg(repo)}/pulls/${pullNumber}/comments`,
      { body, in_reply_to: commentId },
      { signal: ctx.signal },
    );
  }

  if (commentResponse && reactionResponse) {
    return {
      comment: defined({
        id: String(commentResponse.id ?? ''),
        html_url: nonEmpty(commentResponse.html_url),
      }),
      reaction: { id: String(reactionResponse.id ?? '') },
    };
  }
  if (commentResponse) {
    return defined({ id: String(commentResponse.id ?? ''), html_url: nonEmpty(commentResponse.html_url) });
  }
  return { id: String(reactionResponse?.id ?? '') };
}

export default {
  pull_request_read: pullRequestRead,
  list_pull_requests: listPullRequests,
  search_pull_requests: searchPullRequests,
  merge_pull_request: mergePullRequest,
  update_pull_request_branch: updatePullRequestBranch,
  create_pull_request: createPullRequest,
  update_pull_request: updatePullRequest,
  pull_request_review_write: pullRequestReviewWrite,
  add_comment_to_pending_review: addCommentToPendingReview,
  add_reply_to_pull_request_comment: addReplyToPullRequestComment,
};

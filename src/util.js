/**
 * util.js — small argument/response helpers shared by every handler.
 *
 * Handlers stay thin and declarative: pull the arguments out, call the API,
 * return plain JSON. Anything reusable lives here so the handler files do not
 * grow private dialects.
 */

/** Throw a tool-visible error. The harness surfaces `message` to the model. */
export function toolError(message) {
  const error = new Error(message);
  error.name = 'GitHubToolError';
  return error;
}

export function fail(message) {
  throw toolError(message);
}

/** Read a required string argument, optionally accepting aliases. */
export function requireString(args, key, aliases = []) {
  for (const name of [key, ...aliases]) {
    const value = args?.[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  fail(`missing required argument: ${key}`);
  return undefined;
}

/** Read an optional string argument. */
export function optionalString(args, key, aliases = []) {
  for (const name of [key, ...aliases]) {
    const value = args?.[name];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Read an optional boolean with a default. Accepts the strings "true"/"false". */
export function optionalBoolean(args, key, fallback = undefined) {
  const value = args?.[key];
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Coerce to a positive integer, or return the fallback. */
export function toPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/** Clamp a page size to GitHub's 1..100 window. */
export function clampPerPage(value, fallback = 30) {
  const parsed = toPositiveInt(value, fallback);
  return Math.min(Math.max(parsed, 1), 100);
}

/** Standard `{ page, per_page }` REST query derived from tool arguments. */
export function paginationQuery(args = {}, { defaultPerPage = 30 } = {}) {
  return {
    page: toPositiveInt(args.page, 1),
    per_page: clampPerPage(args.perPage ?? args.per_page, defaultPerPage),
  };
}

/**
 * Accepts either `owner` + `repo`, or a single `repository`/`repo` slug.
 * @returns {{ owner: string, repo: string }}
 */
export function requireOwnerRepo(args = {}) {
  const slug = optionalString(args, 'repository', ['repo']);
  if (slug && slug.includes('/')) {
    const [owner, repo] = slug.split('/', 2);
    if (owner && repo) return { owner, repo };
  }
  const owner = optionalString(args, 'owner');
  const repo = optionalString(args, 'repo') ?? (slug && !slug.includes('/') ? slug : undefined);
  if (!owner || !repo) {
    fail('missing required arguments: owner and repo (or repository: "owner/repo")');
  }
  return { owner, repo };
}

/** Split `owner/repo` (validating the shape). */
export function parseRepoSlug(slug) {
  if (typeof slug !== 'string' || !slug.includes('/')) fail(`invalid repository: ${String(slug)}`);
  const [owner, repo, ...rest] = slug.split('/');
  if (!owner || !repo || rest.length > 0) fail(`invalid repository: ${slug}`);
  return { owner, repo };
}

/** Drop keys whose value is `undefined` (keeps PATCH/POST bodies clean). */
export function defined(object) {
  const out = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/** Always return an array. */
export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Validate a value against an allowed set (case-insensitively for strings). */
export function requireEnum(value, allowed, argumentName) {
  const normalized = String(value ?? '').toLowerCase();
  const match = allowed.find((entry) => entry.toLowerCase() === normalized);
  if (match === undefined) fail(`invalid ${argumentName}: expected one of ${allowed.join(', ')}`);
  return match;
}

/** URL-encode a path segment (owner, repo, branch, ref, path …). */
export function seg(value) {
  return encodeURIComponent(String(value));
}

/** URL-encode a file path while keeping `/` separators. */
export function pathSeg(value) {
  return String(value)
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

/**
 * The canonical list envelope used by list-style tools.
 * `has_more` is only reported when the caller knows the total.
 */
export function listResult(items, { page, perPage, totalCount } = {}) {
  const out = { items };
  if (typeof totalCount === 'number') out.total_count = totalCount;
  if (typeof page === 'number') out.page = page;
  if (typeof perPage === 'number') out.per_page = perPage;
  if (typeof totalCount === 'number' && typeof page === 'number' && typeof perPage === 'number') {
    out.has_more = page * perPage < totalCount;
  }
  return out;
}

/**
 * Follow REST pagination for a list-style tool.
 * @param {import('./client.js').GitHubClient} client
 * @param {string} path
 * @param {object} args tool arguments (`page`, `perPage`)
 * @param {object} [options] `{ query, defaultPerPage, maxItems }`
 */
export async function restList(client, path, args = {}, options = {}) {
  const { page, per_page } = paginationQuery(args, { defaultPerPage: options.defaultPerPage ?? 30 });
  const query = { ...options.query, page, per_page };
  if (options.maxItems === undefined) {
    const items = await client.rest('GET', path, { query, signal: options.signal });
    return { items: Array.isArray(items) ? items : (items?.items ?? []), page, perPage: per_page, raw: items };
  }
  const items = await client.paginate(path, { query, maxItems: options.maxItems, perPage: per_page, signal: options.signal });
  return { items, page, perPage: per_page };
}

/** Trim a possibly-huge string field for list rendering. */
export function excerpt(value, length = 500) {
  if (typeof value !== 'string') return value;
  if (value.length <= length) return value;
  return `${value.slice(0, length)}…`;
}

/**
 * Pick a nested GraphQL connection. `get(data, 'repository.pullRequest.comments')`.
 * Returns `undefined` when any hop is missing.
 */
export function pick(object, path) {
  let current = object;
  for (const key of String(path).split('.')) {
    if (current === undefined || current === null) return undefined;
    current = current[key];
  }
  return current;
}

/** A compact `{number, title, state, url}` summary used by many list tools. */
export function summarizeIssue(issue) {
  if (!issue) return null;
  return defined({
    number: issue.number,
    title: issue.title,
    state: issue.state ?? issue.state_reason,
    user: issue.user?.login,
    labels: Array.isArray(issue.labels) ? issue.labels.map((label) => (typeof label === 'string' ? label : label?.name)) : undefined,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    html_url: issue.html_url,
    pull_request: issue.pull_request ? true : undefined,
  });
}

/** GraphQL global node id for a repository (used by GraphQL-backed tools). */
export async function repositoryNodeId(client, owner, repo, signal) {
  const data = await client.graphql(
    'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id nameWithOwner } }',
    { owner, name: repo },
    { signal },
  );
  const id = data?.repository?.id;
  if (!id) fail(`repository not found: ${owner}/${repo}`);
  return id;
}

/** The numeric database id for an issue or pull request (REST lookup). */
export async function issueDatabaseId(client, owner, repo, number, signal) {
  const issue = await client.rest('GET', `/repos/${seg(owner)}/${seg(repo)}/issues/${number}`, { signal });
  const id = issue?.id;
  if (!id) fail(`issue #${number} not found in ${owner}/${repo}`);
  return { databaseId: id, issue };
}

export { toPositiveInt as toInt };

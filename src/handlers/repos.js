/**
 * repos.js — 25 tool handlers.
 *
 *   - create_branch
 *   - create_or_update_file
 *   - create_repository
 *   - delete_file
 *   - delete_repository
 *   - fork_repository
 *   - get_commit
 *   - get_file_blame
 *   - get_file_contents
 *   - get_latest_release
 *   - get_release_by_tag
 *   - get_tag
 *   - list_branches
 *   - list_commits
 *   - list_releases
 *   - list_repository_collaborators
 *   - list_tags
 *   - push_files
 *   - search_code
 *   - search_commits
 *   - search_repositories
 *   - get_repository_tree
 *   - list_starred_repositories
 *   - star_repository
 *   - unstar_repository
 *
 * Ported from the upstream Go server:
 *   pkg/github/repositories.go   (most tools; the In/Out structs live in
 *                                 pkg/github/repository_tool_types.go)
 *   pkg/github/git.go            (get_repository_tree)
 *   pkg/github/search.go         (search_code, search_commits, search_repositories)
 *   pkg/github/repositories_helper.go + pkg/github/repository_path.go
 *                                (path validation, ref resolution, the
 *                                 create/update/push plumbing)
 *
 * The upstream text results are MCP content blocks; a DSH handler returns one
 * plain JSON object, so every tool returns the *structured* output the Go
 * handler builds (its `Out` type), which is also what `outputSchema` in
 * `src/generated/tools.json` describes. Where that structured output is a bare
 * array, it is wrapped in this plugin's list envelope (a deliberate deviation
 * from upstream, documented in README.md under "Deviations").
 */

import {
  defined,
  fail,
  optionalBoolean,
  optionalString,
  pathSeg,
  seg,
  toPositiveInt,
} from '../util.js';

// ---------------------------------------------------------------------------
// Shared argument helpers (upstream params.go / repository_path.go)
// ---------------------------------------------------------------------------

/**
 * Read a required string argument with the upstream error wording; the Go
 * handlers answer `missing required parameter: <name>`.
 */
function requireParameter(args, key, aliases = []) {
  const value = optionalString(args, key, aliases);
  if (value === undefined) fail(`missing required parameter: ${key}`);
  return value;
}

/** `owner` + `repo`, the coordinate every repository tool takes. */
function ownerRepo(args) {
  return { owner: requireParameter(args, 'owner'), repo: requireParameter(args, 'repo') };
}

/** Upstream `repositoryPagination`: page 1 / perPage 30; `0` means "use the default". */
function repositoryPagination(args) {
  return {
    page: toPositiveInt(args?.page, 1),
    perPage: toPositiveInt(args?.perPage ?? args?.per_page, 30),
  };
}

/**
 * Upstream `validateRelativePath` (pkg/github/repository_path.go): strip one
 * leading slash, reject absolute paths, backslashes, `..` segments and paths
 * that do not identify a file, then return the cleaned path.
 */
function validateRelativePath(value) {
  let cleaned = String(value ?? '');
  if (cleaned.startsWith('/')) cleaned = cleaned.slice(1);
  if (cleaned === '') fail('invalid path: path must not be empty');
  if (cleaned.startsWith('/')) fail('invalid path: path must be relative');
  if (cleaned.includes('\\')) fail('invalid path: path must use forward slashes');
  if (cleaned.split('/').includes('..')) fail('invalid path: path must not contain parent directory traversal');
  const parts = [];
  for (const part of cleaned.split('/')) {
    if (part === '' || part === '.') continue;
    parts.push(part);
  }
  const result = parts.join('/');
  if (result === '') fail('invalid path: path must identify a file');
  return result;
}

/** Upstream `looksLikeSHA`: exactly 40 hex characters. */
function looksLikeSHA(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Upstream `parseISOTimestamp` (pkg/github/issues.go): RFC3339 or `YYYY-MM-DD`.
 * Returns the value in the RFC3339-seconds form Go puts on the wire.
 */
function parseISOTimestamp(value) {
  const text = String(value ?? '');
  const shape = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2}))?$/.test(text);
  const date = shape ? new Date(text) : new Date(Number.NaN);
  if (!shape || Number.isNaN(date.getTime())) {
    return {
      error: `invalid ISO 8601 timestamp: ${text} (supported formats: YYYY-MM-DDThh:mm:ssZ or YYYY-MM-DD)`,
    };
  }
  return { value: date.toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

// ---------------------------------------------------------------------------
// Content sanitisation (upstream pkg/sanitize)
// ---------------------------------------------------------------------------

/**
 * NOTE: upstream runs every untrusted, user-authored string through
 * `pkg/sanitize` (bluemonday HTML policies). DSH ships no HTML sanitiser and no
 * new dependency is allowed, so this is a reduced port: it drops the
 * invisible/format/control characters `sanitize.FilterInvisibleCharacters`
 * removes, and `sanitizePlainText` additionally strips HTML tags. The
 * bluemonday policy itself is NOT reproduced.
 */
function stripInvisible(value) {
  if (typeof value !== 'string' || value === '') return value;
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0);
    const isControl = code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    const isAllowedControl = char === '\n' || char === '\r' || char === '\t';
    const isZeroWidth =
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x2064) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff;
    if ((isControl && !isAllowedControl) || isZeroWidth) continue;
    out += char;
  }
  return out;
}

/** Upstream `sanitize.Content`: invisible characters only. */
function sanitizeContent(value) {
  return stripInvisible(value);
}

/** Upstream `sanitize.PlainText`: invisible characters plus HTML neutralisation. */
function sanitizePlainText(value) {
  if (typeof value !== 'string') return value;
  return stripInvisible(stripInvisible(value).replace(/<[^>]*>/g, ''));
}

// ---------------------------------------------------------------------------
// Minimal output shapes (upstream pkg/github/minimal_types.go)
// ---------------------------------------------------------------------------

/** `formatRFC3339` — Go's `time.Format(time.RFC3339)` / `"2006-01-02T15:04:05Z"`. */
function formatRFC3339(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `MinimalUser` — `{login, id?, profile_url?, avatar_url?}`. */
function minimalUser(user) {
  if (user === null || typeof user !== 'object') return undefined;
  return defined({
    login: user.login ?? '',
    id: user.id,
    profile_url: user.html_url,
    avatar_url: user.avatar_url,
  });
}

/** `MinimalCommitAuthor` — every field is `omitempty`. */
function minimalCommitAuthor(author) {
  if (author === null || typeof author !== 'object') return undefined;
  return defined({
    name: author.name,
    email: author.email,
    date: author.date ? formatRFC3339(author.date) : undefined,
  });
}

/** `MinimalCommitInfo` — `message` is always present. */
function minimalCommitInfo(commit) {
  if (commit === null || typeof commit !== 'object') return undefined;
  return defined({
    message: sanitizeContent(commit.message ?? ''),
    author: minimalCommitAuthor(commit.author),
    committer: minimalCommitAuthor(commit.committer),
  });
}

/**
 * Upstream `newMinimalCommitFromCore` + `convertToMinimalCommit`.
 * `detail` is `none`, `stats` (the default) or `full_patch`.
 */
function minimalCommit(commit, detail = 'stats') {
  const source = commit !== null && typeof commit === 'object' ? commit : {};
  const out = {
    sha: source.sha ?? '',
    html_url: source.html_url ?? '',
    commit: minimalCommitInfo(source.commit),
    author: minimalUser(source.author),
    committer: minimalUser(source.committer),
  };
  if (detail === 'none') return defined(out);

  if (source.stats !== null && typeof source.stats === 'object') {
    out.stats = defined({
      additions: source.stats.additions,
      deletions: source.stats.deletions,
      total: source.stats.total,
    });
  }
  if (Array.isArray(source.files) && source.files.length > 0) {
    out.files = source.files.map((file) => {
      const entry = file !== null && typeof file === 'object' ? file : {};
      return defined({
        filename: entry.filename ?? '',
        status: entry.status,
        additions: entry.additions,
        deletions: entry.deletions,
        changes: entry.changes,
        patch: detail === 'full_patch' ? entry.patch : undefined,
      });
    });
  }
  return defined(out);
}

/** `MinimalCommitSearchItem` — a commit plus the repository it came from. */
function minimalCommitSearchItem(commit) {
  const source = commit !== null && typeof commit === 'object' ? commit : {};
  const item = minimalCommit(source, 'none');
  if (source.repository !== null && typeof source.repository === 'object') {
    item.repository = defined({
      full_name: source.repository.full_name ?? '',
      html_url: source.repository.html_url,
      private: source.repository.private === true ? true : undefined,
    });
  }
  return item;
}

/** `MinimalRepository` — list_starred_repositories and search_repositories. */
function minimalRepository(repo) {
  const source = repo !== null && typeof repo === 'object' ? repo : {};
  return defined({
    id: source.id ?? 0,
    name: source.name ?? '',
    full_name: source.full_name ?? '',
    description: source.description,
    html_url: source.html_url ?? '',
    language: source.language,
    stargazers_count: source.stargazers_count ?? 0,
    forks_count: source.forks_count ?? 0,
    open_issues_count: source.open_issues_count ?? 0,
    updated_at: source.updated_at ? formatRFC3339(source.updated_at) : undefined,
    created_at: source.created_at ? formatRFC3339(source.created_at) : undefined,
    topics: Array.isArray(source.topics) ? source.topics : undefined,
    private: source.private === true,
    fork: source.fork === true,
    archived: source.archived === true,
    default_branch: source.default_branch,
  });
}

/** `SearchRepository` — the `minimal_output: false` projection. */
function fullSearchRepository(repo) {
  const source = repo !== null && typeof repo === 'object' ? repo : {};
  const out = {
    ...minimalRepository(source),
    homepage: source.homepage,
    visibility: source.visibility,
    pushed_at: source.pushed_at ? formatRFC3339(source.pushed_at) : undefined,
    watchers_count: source.watchers_count,
    size: source.size,
    disabled: source.disabled,
    is_template: source.is_template,
    has_issues: source.has_issues,
    has_projects: source.has_projects,
    has_wiki: source.has_wiki,
    has_discussions: source.has_discussions,
  };
  if (source.license !== null && typeof source.license === 'object') {
    out.license = defined({
      key: source.license.key,
      name: source.license.name,
      spdx_id: source.license.spdx_id,
    });
  }
  if (source.permissions !== null && typeof source.permissions === 'object') {
    out.permissions = defined({
      admin: source.permissions.admin,
      maintain: source.permissions.maintain,
      push: source.permissions.push,
      triage: source.permissions.triage,
      pull: source.permissions.pull,
    });
  }
  return defined(out);
}

/** `MinimalBranch` — `{name, sha, protected}`. */
function minimalBranch(branch) {
  const source = branch !== null && typeof branch === 'object' ? branch : {};
  return {
    name: source.name ?? '',
    sha: source.commit?.sha ?? '',
    protected: source.protected === true,
  };
}

/** `MinimalTag` — `{name, sha}`. */
function minimalTag(tag) {
  const source = tag !== null && typeof tag === 'object' ? tag : {};
  return { name: source.name ?? '', sha: source.commit?.sha ?? '' };
}

/** `MinimalRelease` — `{id, tag_name, name?, body?, html_url, published_at?, prerelease, draft, author?}`. */
function minimalRelease(release) {
  const source = release !== null && typeof release === 'object' ? release : {};
  return defined({
    id: source.id ?? 0,
    tag_name: source.tag_name ?? '',
    name: sanitizePlainText(source.name),
    body: sanitizeContent(source.body),
    html_url: source.html_url ?? '',
    published_at: source.published_at ? formatRFC3339(source.published_at) : undefined,
    prerelease: source.prerelease === true,
    draft: source.draft === true,
    author: minimalUser(source.author),
  });
}

/** `MinimalFileContentResponse` — the create/update file result. */
function minimalFileContentResponse(response) {
  const source = response !== null && typeof response === 'object' ? response : {};
  const out = {};
  if (source.content !== null && typeof source.content === 'object') {
    out.content = defined({
      name: source.content.name ?? '',
      path: source.content.path ?? '',
      sha: source.content.sha ?? '',
      size: source.content.size,
      html_url: source.content.html_url ?? '',
    });
  }
  if (source.commit !== null && typeof source.commit === 'object') {
    out.commit = defined({
      sha: source.commit.sha ?? '',
      message: sanitizeContent(source.commit.message),
      html_url: source.commit.html_url,
      author: minimalCommitAuthor(source.commit.author),
    });
  }
  return out;
}

/** `RepositoryReferenceOutput` — `{ref, object:{type, sha}}`. */
function repositoryReferenceOutput(ref) {
  if (ref === null || typeof ref !== 'object') return undefined;
  return {
    ref: ref.ref ?? '',
    object: { type: ref.object?.type ?? '', sha: ref.object?.sha ?? '' },
  };
}

/** `RepositoryGitCommitOutput`. */
function repositoryGitCommitOutput(commit) {
  if (commit === null || typeof commit !== 'object') return undefined;
  const parents = Array.isArray(commit.parents)
    ? commit.parents.filter(Boolean).map((parent) => parent?.sha ?? '')
    : undefined;
  return defined({
    sha: commit.sha ?? '',
    message: commit.message,
    html_url: commit.html_url,
    author: minimalCommitAuthor(commit.author),
    committer: minimalCommitAuthor(commit.committer),
    tree_sha: commit.tree?.sha,
    parents: parents && parents.length > 0 ? parents : undefined,
  });
}

/** `RepositoryAnnotatedTagOutput`. */
function repositoryAnnotatedTagOutput(tag) {
  if (tag === null || typeof tag !== 'object') return undefined;
  const out = defined({
    tag: tag.tag ?? '',
    sha: tag.sha ?? '',
    message: tag.message,
    tagger: minimalCommitAuthor(tag.tagger),
  });
  if (tag.object !== null && typeof tag.object === 'object') {
    out.object = { type: tag.object.type ?? '', sha: tag.object.sha ?? '' };
  }
  return out;
}

/** Upstream `filterFields`: keep only the requested keys the object actually has. */
function filterFields(object, fields) {
  const picked = {};
  for (const field of fields) {
    if (object !== null && typeof object === 'object' && Object.hasOwn(object, field)) {
      picked[field] = object[field];
    }
  }
  return picked;
}

/** Upstream `filterEachField`. */
function filterEachField(items, fields) {
  return items.map((item) => filterFields(item, fields));
}

/** Read the optional `fields` string-array argument. */
function optionalFields(args, key = 'fields') {
  const value = args?.[key];
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === 'string' && entry.length > 0);
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/** go-github's `refsShortName`: strip the `refs/` prefix before putting it in a URL. */
function refShortName(ref) {
  return pathSeg(String(ref).replace(/^refs\//, ''));
}

// ---------------------------------------------------------------------------
// get_commit / list_commits
// ---------------------------------------------------------------------------

/** `get_commit` — GET /repos/{owner}/{repo}/commits/{sha}. */
async function getCommit(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const sha = requireParameter(args, 'sha');
  const rawDetail = optionalString(args, 'detail');
  const detail = rawDetail === undefined ? 'stats' : rawDetail;
  if (!['none', 'stats', 'full_patch'].includes(detail)) {
    fail(`invalid detail ${JSON.stringify(detail)}: must be one of "none", "stats", "full_patch"`);
  }
  const { page, perPage } = repositoryPagination(args);
  const commit = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/commits/${pathSeg(sha)}`, {
    query: { page, per_page: perPage },
    signal: ctx.signal,
  });
  return minimalCommit(commit, detail);
}

/** `list_commits` — GET /repos/{owner}/{repo}/commits. */
async function listCommits(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const { page, perPage } = repositoryPagination(args);
  const since = optionalString(args, 'since');
  const until = optionalString(args, 'until');
  let sinceValue;
  let untilValue;
  if (since !== undefined) {
    const parsed = parseISOTimestamp(since);
    if (parsed.error) fail(`invalid since timestamp: ${parsed.error}`);
    sinceValue = parsed.value;
  }
  if (until !== undefined) {
    const parsed = parseISOTimestamp(until);
    if (parsed.error) fail(`invalid until timestamp: ${parsed.error}`);
    untilValue = parsed.value;
  }
  const commits = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/commits`, {
    query: defined({
      sha: optionalString(args, 'sha'),
      path: optionalString(args, 'path'),
      author: optionalString(args, 'author'),
      since: sinceValue,
      until: untilValue,
      page,
      per_page: perPage,
    }),
    signal: ctx.signal,
  });
  const items = (Array.isArray(commits) ? commits : []).map((commit) => {
    const item = minimalCommit(commit, 'none');
    return defined({
      sha: item.sha,
      html_url: item.html_url,
      commit: item.commit,
      author: item.author,
      committer: item.committer,
    });
  });
  const fields = optionalFields(args);
  return {
    items: fields.length > 0 ? filterEachField(items, fields) : items,
    page,
    per_page: perPage,
  };
}

// ---------------------------------------------------------------------------
// Branches, tags, releases
// ---------------------------------------------------------------------------

/** `list_branches` — GET /repos/{owner}/{repo}/branches. */
async function listBranches(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const { page, perPage } = repositoryPagination(args);
  const branches = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/branches`, {
    query: { page, per_page: perPage },
    signal: ctx.signal,
  });
  return {
    items: (Array.isArray(branches) ? branches : []).map(minimalBranch),
    page,
    per_page: perPage,
  };
}

/** `list_tags` — GET /repos/{owner}/{repo}/tags. */
async function listTags(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const { page, perPage } = repositoryPagination(args);
  const tags = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/tags`, {
    query: { page, per_page: perPage },
    signal: ctx.signal,
  });
  return {
    items: (Array.isArray(tags) ? tags : []).filter(Boolean).map(minimalTag),
    page,
    per_page: perPage,
  };
}

/** `get_tag` — the tag ref, or the annotated tag object it points at. */
async function getTag(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const tag = requireParameter(args, 'tag');
  const ref = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/tags/${pathSeg(tag)}`, {
    signal: ctx.signal,
  });
  if (ref?.object?.type === 'commit') return repositoryReferenceOutput(ref);
  const sha = ref?.object?.sha;
  if (sha === undefined) fail(`failed to get tag reference: ${tag}`);
  const tagObject = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/git/tags/${seg(sha)}`, {
    signal: ctx.signal,
  });
  return repositoryAnnotatedTagOutput(tagObject);
}

/** `list_releases` — GET /repos/{owner}/{repo}/releases. */
async function listReleases(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const { page, perPage } = repositoryPagination(args);
  const releases = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/releases`, {
    query: { page, per_page: perPage },
    signal: ctx.signal,
  });
  const items = (Array.isArray(releases) ? releases : []).filter(Boolean).map(minimalRelease);
  const fields = optionalFields(args);
  return {
    items: fields.length > 0 ? filterEachField(items, fields) : items,
    page,
    per_page: perPage,
  };
}

/** `get_latest_release` — GET /repos/{owner}/{repo}/releases/latest. */
async function getLatestRelease(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const release = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/releases/latest`, {
    signal: ctx.signal,
  });
  return minimalRelease(release);
}

/** `get_release_by_tag` — GET /repos/{owner}/{repo}/releases/tags/{tag}. */
async function getReleaseByTag(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const tag = requireParameter(args, 'tag');
  const release = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/releases/tags/${pathSeg(tag)}`, {
    signal: ctx.signal,
  });
  return minimalRelease(release);
}

// ---------------------------------------------------------------------------
// create_repository / fork_repository / delete_repository
// ---------------------------------------------------------------------------

/** `create_repository` — POST /user/repos or POST /orgs/{org}/repos. */
async function createRepository(args, ctx) {
  const name = requireParameter(args, 'name');
  const description = optionalString(args, 'description');
  const organization = optionalString(args, 'organization');
  const privateFlag = optionalBoolean(args, 'private', true);
  const autoInit = optionalBoolean(args, 'autoInit', false);

  const body = defined({ name, description, private: privateFlag, auto_init: autoInit });
  const path = organization === undefined ? '/user/repos' : `/orgs/${seg(organization)}/repos`;
  const created = await ctx.client.post(path, body, { signal: ctx.signal });
  return { id: String(created?.id ?? 0), url: created?.html_url ?? '' };
}

/** `fork_repository` — POST /repos/{owner}/{repo}/forks. */
async function forkRepository(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const organization = optionalString(args, 'organization');
  const forked = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/forks`,
    defined({ organization }),
    { signal: ctx.signal },
  );
  // Upstream answers "Fork is in progress" for the 202-with-no-decodable-body
  // case (go-github's `acceptedError`), which the fork endpoint uses while the
  // fork is still being created.
  if (forked === null || typeof forked !== 'object' || forked.id === undefined) {
    return { message: 'Fork is in progress' };
  }
  return { id: String(forked.id), url: forked.html_url ?? '' };
}

/**
 * `delete_repository` — DELETE /repos/{owner}/{repo}.
 *
 * NOTE: upstream refuses to delete until the caller confirms the exact
 * `owner/repo` through an MCP elicitation round-trip, and it seals a
 * request-state token bound to the repository id. DSH tools have no elicitation
 * channel, so this port keeps the upstream identity check (the repository is
 * fetched first and a missing id aborts) but performs the delete in the same
 * call. The confirmation round-trip is NOT reproduced.
 */
async function deleteRepository(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const repository = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}`, { signal: ctx.signal });
  if (repository?.id === undefined || repository.id === null) {
    fail(`failed to get repository: ${owner}/${repo}`);
  }
  await ctx.client.delete(`/repos/${seg(owner)}/${seg(repo)}`, undefined, { signal: ctx.signal });
  return { message: `Repository ${owner}/${repo} was deleted.` };
}

// ---------------------------------------------------------------------------
// star / unstar / starred
// ---------------------------------------------------------------------------

/** `star_repository` — PUT /user/starred/{owner}/{repo}. */
async function starRepository(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  await ctx.client.put(`/user/starred/${seg(owner)}/${seg(repo)}`, undefined, { signal: ctx.signal });
  return { message: `Successfully starred repository ${owner}/${repo}` };
}

/** `unstar_repository` — DELETE /user/starred/{owner}/{repo}. */
async function unstarRepository(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  await ctx.client.delete(`/user/starred/${seg(owner)}/${seg(repo)}`, undefined, { signal: ctx.signal });
  return { message: `Successfully unstarred repository ${owner}/${repo}` };
}

/** `list_starred_repositories` — GET /user/starred or /users/{username}/starred. */
async function listStarredRepositories(args, ctx) {
  const username = optionalString(args, 'username');
  const sort = optionalString(args, 'sort');
  const direction = optionalString(args, 'direction');
  const { page, perPage } = repositoryPagination(args);
  const path = username === undefined ? '/user/starred' : `/users/${seg(username)}/starred`;
  const starred = await ctx.client.get(path, {
    query: defined({ sort, direction, page, per_page: perPage }),
    signal: ctx.signal,
  });
  const items = (Array.isArray(starred) ? starred : [])
    .filter(Boolean)
    .map((entry) => minimalRepository(entry.repository ?? entry));
  return { items, page, per_page: perPage };
}

// ---------------------------------------------------------------------------
// Refs: create_branch / delete_file / push_files
// ---------------------------------------------------------------------------

/** Upstream `resolveDefaultBranch` — the default branch ref of a repository. */
async function resolveDefaultBranch(client, owner, repo, signal) {
  const info = await client.get(`/repos/${seg(owner)}/${seg(repo)}`, { signal });
  const defaultBranch = info?.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    fail(`failed to get repository info: no default branch for ${owner}/${repo}`);
  }
  return client.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${pathSeg(defaultBranch)}`, { signal });
}

/** Upstream `createReferenceFromDefaultBranch`. */
async function createReferenceFromDefaultBranch(client, owner, repo, branch, signal) {
  const defaultRef = await resolveDefaultBranch(client, owner, repo, signal);
  return client.post(
    `/repos/${seg(owner)}/${seg(repo)}/git/refs`,
    { ref: `refs/heads/${branch}`, sha: defaultRef?.object?.sha },
    { signal },
  );
}

/** `create_branch` — POST /repos/{owner}/{repo}/git/refs. */
async function createBranch(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const branch = requireParameter(args, 'branch');
  let fromBranch = optionalString(args, 'from_branch');
  if (fromBranch === undefined) {
    const repository = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}`, { signal: ctx.signal });
    fromBranch = repository?.default_branch;
    if (typeof fromBranch !== 'string' || fromBranch === '') {
      fail(`failed to get repository: ${owner}/${repo}`);
    }
  }
  const ref = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${pathSeg(fromBranch)}`,
    { signal: ctx.signal },
  );
  const sha = ref?.object?.sha;
  if (sha === undefined) fail(`failed to get reference: refs/heads/${fromBranch}`);
  const created = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/git/refs`,
    { ref: `refs/heads/${branch}`, sha },
    { signal: ctx.signal },
  );
  return repositoryReferenceOutput(created);
}

/**
 * `delete_file` — delete a path by writing a tree entry with no SHA, committing
 * it and fast-forwarding the branch ref. Upstream deliberately avoids the REST
 * delete-file endpoint so the commit is signed the same way
 * create_or_update_file's commits are.
 */
async function deleteFile(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const path = validateRelativePath(requireParameter(args, 'path'));
  const message = requireParameter(args, 'message');
  const branch = requireParameter(args, 'branch');

  let ref;
  try {
    ref = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${pathSeg(branch)}`, {
      signal: ctx.signal,
    });
  } catch (error) {
    fail(`failed to get branch reference: ${error?.message ?? error}`);
  }
  const baseSha = ref?.object?.sha;
  if (baseSha === undefined) fail(`failed to get branch reference: refs/heads/${branch}`);

  const baseCommit = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/git/commits/${seg(baseSha)}`,
    { signal: ctx.signal },
  );
  const baseTree = baseCommit?.tree?.sha;
  if (baseTree === undefined) fail(`failed to get base commit: ${baseSha}`);

  const newTree = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/git/trees`,
    { base_tree: baseTree, tree: [{ path, mode: '100644', type: 'blob', sha: null }] },
    { signal: ctx.signal },
  );

  const newCommit = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/git/commits`,
    { message, tree: newTree?.sha, parents: [baseSha] },
    { signal: ctx.signal },
  );

  await ctx.client.patch(
    `/repos/${seg(owner)}/${seg(repo)}/git/refs/${refShortName(ref?.ref ?? `refs/heads/${branch}`)}`,
    { sha: newCommit?.sha, force: false },
    { signal: ctx.signal },
  );

  return { commit: repositoryGitCommitOutput(newCommit), content: null };
}

/** Upstream `initializeRepository` — create the first commit in an empty repo. */
async function initializeRepository(client, owner, repo, signal) {
  const info = await client.get(`/repos/${seg(owner)}/${seg(repo)}`, { signal });
  const defaultBranch = info?.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch === '') {
    fail(`failed to get repository: ${owner}/${repo}`);
  }
  const created = await client.put(
    `/repos/${seg(owner)}/${seg(repo)}/contents/README.md`,
    {
      message: 'Initial commit',
      content: Buffer.from('', 'utf8').toString('base64'),
      branch: defaultBranch,
    },
    { signal },
  );
  const commitSha = created?.commit?.sha;
  if (commitSha === undefined) fail('failed to create initial file');
  const baseCommit = await client.get(`/repos/${seg(owner)}/${seg(repo)}/git/commits/${seg(commitSha)}`, {
    signal,
  });
  const ref = await client.get(
    `/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${pathSeg(defaultBranch)}`,
    { signal },
  );
  return { ref, baseCommit };
}

/** `push_files` — tree + commit + ref update, all in one commit. */
async function pushFiles(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const branch = requireParameter(args, 'branch');
  const message = requireParameter(args, 'message');
  const files = args?.files;
  if (!Array.isArray(files)) {
    fail('files parameter must be an array of objects with path and content');
  }
  const entries = [];
  for (const file of files) {
    const filePath = optionalString(file, 'path');
    if (filePath === undefined) fail('each file must have a path');
    if (typeof file?.content !== 'string') fail('each file must have content');
    let cleaned;
    try {
      cleaned = validateRelativePath(filePath);
    } catch (error) {
      fail(`invalid file path: ${String(error?.message ?? error).replace(/^invalid path: /, '')}`);
    }
    entries.push({ path: cleaned, mode: '100644', type: 'blob', content: file.content });
  }

  let repositoryIsEmpty = false;
  let branchNotFound = false;
  let ref;
  try {
    ref = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/heads/${pathSeg(branch)}`, {
      signal: ctx.signal,
    });
  } catch (error) {
    const status = error?.status;
    const upstreamMessage = error?.body?.message ?? error?.message;
    if (status === 409 && upstreamMessage === 'Git Repository is empty.') repositoryIsEmpty = true;
    else if (status === 404) branchNotFound = true;
    else fail(`failed to get branch reference: ${error?.message ?? error}`);
  }

  let baseCommit;
  if (!repositoryIsEmpty) {
    if (branchNotFound) {
      try {
        ref = await createReferenceFromDefaultBranch(ctx.client, owner, repo, branch, ctx.signal);
      } catch (error) {
        fail(`failed to create branch from default: ${error?.message ?? error}`);
      }
    }
    const refSha = ref?.object?.sha;
    if (refSha === undefined) fail(`failed to get branch reference: refs/heads/${branch}`);
    baseCommit = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/git/commits/${seg(refSha)}`, {
      signal: ctx.signal,
    });
  } else {
    let base;
    try {
      ({ ref, baseCommit: base } = await initializeRepository(ctx.client, owner, repo, ctx.signal));
    } catch (error) {
      fail(`failed to initialize repository: ${error?.message ?? error}`);
    }
    const defaultBranch = String(ref?.ref ?? '').replace(/^refs\/heads\//, '');
    if (branch !== defaultBranch) {
      try {
        ref = await createReferenceFromDefaultBranch(ctx.client, owner, repo, branch, ctx.signal);
      } catch (error) {
        fail(`failed to create branch from default: ${error?.message ?? error}`);
      }
    }
    baseCommit = base;
  }

  const baseTree = baseCommit?.tree?.sha;
  if (baseTree === undefined) fail(`failed to get base commit: ${baseCommit?.sha ?? ''}`);

  const newTree = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/git/trees`,
    { base_tree: baseTree, tree: entries },
    { signal: ctx.signal },
  );

  const newCommit = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/git/commits`,
    { message, tree: newTree?.sha, parents: [baseCommit?.sha] },
    { signal: ctx.signal },
  );

  const updatedRef = await ctx.client.patch(
    `/repos/${seg(owner)}/${seg(repo)}/git/refs/${refShortName(ref?.ref ?? `refs/heads/${branch}`)}`,
    { sha: newCommit?.sha, force: false },
    { signal: ctx.signal },
  );
  return repositoryReferenceOutput(updatedRef);
}

// ---------------------------------------------------------------------------
// create_or_update_file
// ---------------------------------------------------------------------------

/** Upstream `resolveRepositorySymlinkTarget`. */
function resolveRepositorySymlinkTarget(linkPath, target) {
  const targetText = String(target ?? '');
  if (targetText.startsWith('/')) return '';
  const dir = String(linkPath).split('/').slice(0, -1);
  const parts = [];
  for (const segment of [...dir, ...targetText.split('/')]) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return '';
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

/**
 * Upstream `newSymlinkWriteBlockedResult`: the tool fails with the JSON payload
 * `{error: 'symlink_write_requires_opt_in', path, target, resolved_path?}` plus a
 * recovery hint. A DSH handler reports failure by throwing, so the two upstream
 * text blocks are joined into one tool error message.
 */
function symlinkWriteBlocked(path, target) {
  const resolvedTargetPath = resolveRepositorySymlinkTarget(path, target);
  const payload = JSON.stringify(
    defined({
      error: 'symlink_write_requires_opt_in',
      path,
      target: target ?? '',
      resolved_path: resolvedTargetPath === '' ? undefined : resolvedTargetPath,
    }),
  );
  const recovery =
    resolvedTargetPath === ''
      ? `Target is outside this repository. Retarget link: allow_symlink_write=true. Replace with a file: push_files path=${JSON.stringify(path)}.`
      : `Edit target: create_or_update_file path=${JSON.stringify(resolvedTargetPath)}. Retarget link: allow_symlink_write=true. Replace with a file: push_files path=${JSON.stringify(path)}.`;
  fail(`${payload}\n${recovery}`);
}

/**
 * `create_or_update_file` — GET the current contents for the SHA check, then
 * PUT /repos/{owner}/{repo}/contents/{path}.
 *
 * NOTE: upstream additionally re-verifies the path against the Git tree
 * (`symlinkTargetAtPath` plus blob-SHA verification) before allowing an
 * overwrite. This port keeps the Contents-API `type === "symlink"` check, which
 * is the common case, but not the tree/blob cross-check.
 */
async function createOrUpdateFile(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const path = validateRelativePath(requireParameter(args, 'path'));
  const content = requireParameter(args, 'content');
  const message = requireParameter(args, 'message');
  const branch = requireParameter(args, 'branch');
  const sha = optionalString(args, 'sha');
  const allowSymlinkWrite = optionalBoolean(args, 'allow_symlink_write', false);

  const contentsPath = `/repos/${seg(owner)}/${seg(repo)}/contents/${pathSeg(path)}`;
  let existing;
  try {
    existing = await ctx.client.get(contentsPath, { query: { ref: branch }, signal: ctx.signal });
  } catch (error) {
    // A 404 means the file does not exist yet — proceed with creation. Every
    // other status is surfaced.
    if (error?.status !== 404) {
      fail(`failed to ${sha === undefined ? 'check if file exists' : 'verify file SHA'}: ${error?.message ?? error}`);
    }
    existing = undefined;
  }

  if (Array.isArray(existing)) {
    fail(`Path ${path} is a directory, not a file. This tool only works with files.`);
  }

  if (existing !== undefined && existing !== null) {
    if (sha !== undefined) {
      if (existing.sha !== sha) {
        fail(
          `SHA mismatch: provided SHA ${sha} is stale. Current file SHA is ${existing.sha}. ` +
            'The file changed since you read it. Call get_file_contents with ' +
            `owner=${JSON.stringify(owner)}, repo=${JSON.stringify(repo)}, path=${JSON.stringify(path)}, and ref=${JSON.stringify(branch)}; ` +
            'its first text result reports the blob SHA for the requested path. ' +
            'Rebuild your content against what it returns, and retry with the sha parameter set to the SHA that call reports.',
        );
      }
      if (!allowSymlinkWrite && existing.type === 'symlink') {
        symlinkWriteBlocked(path, existing.target);
      }
    } else {
      fail(
        `File already exists at ${path}. You must provide the current file's SHA when updating. ` +
          `Call get_file_contents with owner=${JSON.stringify(owner)}, repo=${JSON.stringify(repo)}, path=${JSON.stringify(path)}, and ref=${JSON.stringify(branch)} to read the file you are about to overwrite; ` +
          'its first text result reports the blob SHA for the requested path. ' +
          'Then retry with the sha parameter set to the blob SHA that call reports.',
      );
    }
  }

  const response = await ctx.client.put(
    contentsPath,
    defined({
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch,
      sha,
    }),
    { signal: ctx.signal },
  );
  return minimalFileContentResponse(response);
}

// ---------------------------------------------------------------------------
// get_file_contents
// ---------------------------------------------------------------------------

/** Upstream `expandRepoResourceURI` — build the `repo://` resource URI. */
function expandRepoResourceURI(owner, repo, sha, ref, pathParts) {
  const base = `repo://${owner}/${repo}`;
  const suffix = `contents/${pathParts.map((part) => encodeURIComponent(part)).join('/')}`;
  if (typeof sha === 'string' && sha !== '') return `${base}/sha/${encodeURIComponent(sha)}/${suffix}`;
  const refText = String(ref ?? '');
  if (refText.startsWith('refs/heads/')) {
    return `${base}/refs/heads/${encodeURIComponent(refText.slice('refs/heads/'.length))}/${suffix}`;
  }
  if (refText.startsWith('refs/tags/')) {
    return `${base}/refs/tags/${encodeURIComponent(refText.slice('refs/tags/'.length))}/${suffix}`;
  }
  if (refText.startsWith('refs/pull/') && refText.endsWith('/head')) {
    const prNumber = refText.slice('refs/pull/'.length, -'/head'.length);
    return `${base}/refs/pull/${encodeURIComponent(prNumber)}/head/${suffix}`;
  }
  if (looksLikeSHA(refText)) return `${base}/sha/${encodeURIComponent(refText)}/${suffix}`;
  if (refText !== '') return `${base}/refs/heads/${encodeURIComponent(refText)}/${suffix}`;
  return `${base}/${suffix}`;
}

/**
 * Upstream `resolveGitReference` — turn `ref`/`sha` into the commit SHA the
 * Contents API is called with. Returns `{ ref, sha, fallbackUsed }`.
 */
async function resolveGitReference(client, owner, repo, ref, sha, signal) {
  if (sha !== undefined && sha !== '') return { ref: '', sha, fallbackUsed: false };
  if (looksLikeSHA(ref)) return { ref: '', sha: ref, fallbackUsed: false };

  const originalRef = ref ?? '';
  let reference;
  let resolvedRef = originalRef;
  let fallbackUsed = false;

  if (originalRef === '') {
    reference = await resolveDefaultBranch(client, owner, repo, signal);
    resolvedRef = reference?.ref ?? resolvedRef;
  } else if (originalRef.startsWith('refs/')) {
    // Already fully qualified; fetched below.
  } else if (originalRef.startsWith('heads/') || originalRef.startsWith('tags/')) {
    resolvedRef = `refs/${originalRef}`;
  } else {
    const branchRef = `refs/heads/${originalRef}`;
    try {
      reference = await client.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/${refShortName(branchRef)}`, {
        signal,
      });
      resolvedRef = branchRef;
    } catch (error) {
      if (error?.status !== 404) {
        fail(`failed to get reference for branch '${originalRef}': ${error?.message ?? error}`);
      }
      const tagRef = `refs/tags/${originalRef}`;
      try {
        reference = await client.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/${refShortName(tagRef)}`, {
          signal,
        });
        resolvedRef = tagRef;
      } catch (tagError) {
        if (tagError?.status !== 404) {
          fail(`failed to get reference for tag '${originalRef}': ${tagError?.message ?? tagError}`);
        }
        if (originalRef !== 'main') {
          fail(`could not resolve ref ${JSON.stringify(originalRef)} as a branch or a tag`);
        }
        reference = await resolveDefaultBranch(client, owner, repo, signal);
        resolvedRef = reference?.ref ?? resolvedRef;
        fallbackUsed = true;
      }
    }
  }

  if (reference === undefined) {
    try {
      reference = await client.get(`/repos/${seg(owner)}/${seg(repo)}/git/ref/${refShortName(resolvedRef)}`, {
        signal,
      });
    } catch (error) {
      if (resolvedRef === 'refs/heads/main') {
        reference = await resolveDefaultBranch(client, owner, repo, signal);
        resolvedRef = reference?.ref ?? resolvedRef;
        fallbackUsed = true;
      } else {
        fail(`failed to get final reference for ${JSON.stringify(resolvedRef)}: ${error?.message ?? error}`);
      }
    }
  }

  return { ref: resolvedRef, sha: reference?.object?.sha ?? '', fallbackUsed };
}

/**
 * Upstream `filterPaths`: tree entries whose path ends with `path`; directories
 * get a trailing slash. Capped at `maxResults`.
 */
function filterPaths(entries, path, maxResults) {
  let wanted = String(path ?? '');
  let dirOnly = false;
  if (wanted.endsWith('/')) {
    dirOnly = true;
    wanted = wanted.slice(0, -1);
  }
  const matched = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (matched.length === maxResults) break;
    if (dirOnly && entry?.type !== 'tree') continue;
    let entryPath = entry?.path ?? '';
    if (entryPath === '') continue;
    if (entryPath.endsWith(wanted)) {
      if (entry.type === 'tree') entryPath += '/';
      matched.push(entryPath);
    }
  }
  return matched;
}

/**
 * Upstream `matchFiles`: when the Contents API cannot resolve the path, search
 * the recursive Git tree for suffix matches and report them.
 * `resolved` is the `raw.ContentOpts` the resolver produced (`Ref`/`SHA` are
 * marshalled with their Go field names, as upstream does).
 */
async function matchFiles(client, owner, repo, ref, path, resolved, signal) {
  const tree = await client.get(`/repos/${seg(owner)}/${seg(repo)}/git/trees/${pathSeg(ref)}`, {
    query: { recursive: 1 },
    signal,
  });
  const matchingFiles = filterPaths(tree?.entries, path, 3);
  if (matchingFiles.length > 0) {
    const resolvedRefs = JSON.stringify({ Ref: resolved.ref, SHA: resolved.sha });
    return (
      'Resolved potential matches in the repository tree ' +
      `(resolved refs: ${resolvedRefs}, matching files: ${JSON.stringify(matchingFiles)}).`
    );
  }
  fail(
    'Failed to get file contents. The path does not point to a file or directory, or the file does not exist in the repository.',
  );
  return '';
}

/**
 * Upstream `inspectRepositoryFile`, reduced: submodules and symlinks are
 * reported through `repositoryPathMetadata`; everything else is decoded from
 * the Contents API's base64 `content`.
 *
 * NOTE: the upstream blob-SHA verification (`gitBlobSHA` + `getVerifiedBlob`)
 * that detects a mislabelled symlink blob is not reproduced.
 */
function inspectRepositoryFile(path, file) {
  const type = file?.type ?? '';
  if (type === 'submodule' || file?.submodule_git_url) {
    return {
      metadata: defined({ type: 'submodule', path, sha: file?.sha, git_url: file?.submodule_git_url }),
      content: Buffer.alloc(0),
      contentAvailable: false,
    };
  }
  const encoded = file?.content;
  let content = Buffer.alloc(0);
  let contentAvailable;
  if (typeof encoded !== 'string') {
    contentAvailable = type !== 'symlink' && (file?.size ?? 0) === 0;
  } else {
    content = Buffer.from(encoded, 'base64');
    contentAvailable = true;
  }
  if (type === 'symlink') {
    return {
      metadata: defined({
        type: 'symlink',
        path,
        sha: file?.sha,
        target: file?.target,
        resolved_path: resolveRepositorySymlinkTarget(path, file?.target ?? ''),
      }),
      content,
      contentAvailable,
    };
  }
  return { metadata: undefined, content, contentAvailable };
}

/** Upstream `marshalRepositoryPathMetadata` — the JSON payload used as the message. */
function marshalRepositoryPathMetadata(metadata, content, note) {
  return JSON.stringify(
    defined({
      ...metadata,
      content,
      note: typeof note === 'string' && note.trim() !== '' ? note.trim() : undefined,
    }),
  );
}

/** Upstream `repositoryReadMessage`. */
function repositoryReadMessage(read, fallback, note) {
  if (read.metadata === undefined) return fallback;
  const content = read.contentAvailable ? 'dereferenced_target' : 'not_returned';
  return marshalRepositoryPathMetadata(read.metadata, content, note);
}

/**
 * NOTE: stand-in for Go's `http.DetectContentType` — text when the bytes are
 * valid UTF-8 and free of NUL bytes, otherwise binary. The MIME type is
 * therefore reported as `text/plain` or `application/octet-stream` rather than
 * the sniffed type.
 */
function detectContentType(bytes) {
  const sample = bytes.subarray(0, 8192);
  for (const byte of sample) {
    if (byte === 0) return { type: 'application/octet-stream', text: false };
  }
  if (sample.toString('utf8').includes('\uFFFD')) return { type: 'application/octet-stream', text: false };
  return { type: 'text/plain', text: true };
}

/** `get_file_contents` — GET /repos/{owner}/{repo}/contents/{path}. */
async function getFileContents(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  let path = optionalString(args, 'path') ?? '/';
  if (path.startsWith('/')) path = path.slice(1);
  const refInput = optionalString(args, 'ref');
  const shaInput = optionalString(args, 'sha');
  const fields = optionalFields(args);

  let resolved;
  try {
    resolved = await resolveGitReference(ctx.client, owner, repo, refInput, shaInput, ctx.signal);
  } catch (error) {
    fail(`failed to resolve git reference: ${error?.message ?? error}`);
  }
  const ref = resolved.sha !== '' ? resolved.sha : resolved.ref;

  const contentsPath = `/repos/${seg(owner)}/${seg(repo)}/contents/${pathSeg(path)}`;
  let fileContent;
  let dirContent;
  try {
    const body = await ctx.client.get(contentsPath, { query: { ref }, signal: ctx.signal });
    if (Array.isArray(body)) dirContent = body;
    else if (body !== null && typeof body === 'object') fileContent = body;
  } catch {
    fileContent = undefined;
    dirContent = undefined;
  }

  if (fileContent === undefined && dirContent === undefined) {
    const message = await matchFiles(ctx.client, owner, repo, ref, path, resolved, ctx.signal);
    return { content: [{ type: 'text', text: message }] };
  }

  if (fileContent !== undefined) {
    const fileSHA = fileContent.sha ?? '';
    const fileSize = fileContent.size ?? 0;
    const resourceURI = expandRepoResourceURI(owner, repo, shaInput, ref, path.split('/'));
    const successNote = resolved.fallbackUsed
      ? ` Note: the provided ref '${refInput}' does not exist, default branch '${resolved.ref}' was used instead.`
      : '';

    const read = inspectRepositoryFile(path, fileContent);
    if (read.metadata?.type === 'submodule') {
      return { content: [{ type: 'text', text: marshalRepositoryPathMetadata(read.metadata, '', successNote) }] };
    }
    if (read.metadata?.type === 'symlink' && !read.contentAvailable) {
      return {
        content: [{ type: 'text', text: marshalRepositoryPathMetadata(read.metadata, 'not_returned', successNote) }],
      };
    }

    const maxContentSize = 1024 * 1024;
    const blocks = [];
    if (read.contentAvailable && read.content.length === 0) {
      blocks.push({
        type: 'text',
        text: repositoryReadMessage(
          read,
          `successfully downloaded empty file (SHA: ${fileSHA})${successNote}`,
          successNote,
        ),
      });
      blocks.push({ type: 'resource', resource: { uri: resourceURI, mimeType: 'text/plain' } });
      return { content: blocks };
    }

    if (fileSize >= maxContentSize) {
      blocks.push({
        type: 'text',
        text: repositoryReadMessage(
          read,
          `File ${path} is too large to display (${fileSize} bytes). Use the download URL to fetch the content: ${fileContent.download_url} (SHA: ${fileSHA})${successNote}`,
          successNote,
        ),
      });
      blocks.push({
        type: 'resource_link',
        uri: resourceURI,
        name: fileContent.name ?? '',
        title:
          read.metadata === undefined
            ? `File: ${path}`
            : `Dereferenced target ${read.metadata.resolved_path} via symlink ${path}`,
        size: fileSize,
      });
      return { content: blocks };
    }

    if (!read.contentAvailable) fail('failed to inspect repository file: content unavailable');

    const detected = detectContentType(read.content);
    if (detected.text) {
      blocks.push({
        type: 'text',
        text: repositoryReadMessage(
          read,
          `successfully downloaded text file (SHA: ${fileSHA})${successNote}`,
          successNote,
        ),
      });
      blocks.push({
        type: 'resource',
        resource: { uri: resourceURI, mimeType: detected.type, text: read.content.toString('utf8') },
      });
      return { content: blocks };
    }

    blocks.push({
      type: 'text',
      text: repositoryReadMessage(
        read,
        `successfully downloaded binary file (SHA: ${fileSHA})${successNote}`,
        successNote,
      ),
    });
    blocks.push({
      type: 'resource',
      resource: { uri: resourceURI, mimeType: detected.type, blob: read.content.toString('base64') },
    });
    return { content: blocks };
  }

  // Directory listing.
  const entries = dirContent.map((entry) => {
    const source = entry !== null && typeof entry === 'object' ? entry : {};
    return defined({
      type: source.type,
      name: source.name,
      path: source.path,
      sha: source.sha,
      size: source.size,
      html_url: source.html_url,
      download_url: source.download_url,
      url: source.url,
      git_url: source.git_url,
      target: source.target,
      submodule_git_url: source.submodule_git_url,
    });
  });
  const filtered = fields.length > 0 ? filterEachField(entries, fields) : entries;
  if (fields.length === 0) {
    // Upstream clears the API-only URL fields from the unprojected listing.
    for (const entry of filtered) {
      delete entry.url;
      delete entry.git_url;
    }
  }
  // NOTE: upstream's structured output for a directory is a bare array of
  // entries; this plugin wraps it under `directory` (see README.md "Deviations").
  return { directory: filtered };
}

// ---------------------------------------------------------------------------
// search_code / search_commits / search_repositories
// ---------------------------------------------------------------------------

/**
 * `search_code` — GET /search/code.
 *
 * `client.rest` is used instead of `client.search` so the
 * `application/vnd.github.text-match+json` accept header (upstream
 * `SearchOptions.TextMatch = true`) reaches the request; like the upstream
 * handler this returns exactly one page.
 */
async function searchCode(args, ctx) {
  const query = requireParameter(args, 'query');
  const { page, perPage } = repositoryPagination(args);
  const result = await ctx.client.rest('GET', '/search/code', {
    query: defined({
      q: query,
      sort: optionalString(args, 'sort'),
      order: optionalString(args, 'order'),
      page,
      per_page: perPage,
    }),
    headers: { accept: 'application/vnd.github.text-match+json' },
    signal: ctx.signal,
  });
  const rawItems = Array.isArray(result?.items) ? result.items : [];
  const items = rawItems.map((code) => {
    const source = code !== null && typeof code === 'object' ? code : {};
    return defined({
      name: source.name ?? '',
      path: source.path ?? '',
      sha: source.sha ?? '',
      repository: source.repository?.full_name,
      text_matches: source.text_matches,
    });
  });
  const fields = optionalFields(args);
  return {
    total_count: result?.total_count ?? 0,
    incomplete_results: result?.incomplete_results === true,
    items: fields.length > 0 ? filterEachField(items, fields) : items,
  };
}

/** `search_commits` — GET /search/commits. */
async function searchCommits(args, ctx) {
  const query = requireParameter(args, 'query');
  const { page, perPage } = repositoryPagination(args);
  const result = await ctx.client.search('/search/commits', {
    query: defined({
      q: query,
      sort: optionalString(args, 'sort'),
      order: optionalString(args, 'order'),
      page,
    }),
    perPage,
    maxItems: page * perPage,
    signal: ctx.signal,
  });
  return {
    total_count: result?.total_count ?? 0,
    incomplete_results: result?.incomplete_results === true,
    items: (result?.items ?? []).map(minimalCommitSearchItem),
  };
}

/**
 * `search_repositories` — GET /search/repositories.
 * `minimal_output` defaults to true; `false` returns the curated
 * `SearchRepository` projection, never the raw REST object.
 */
async function searchRepositories(args, ctx) {
  const query = requireParameter(args, 'query');
  const { page, perPage } = repositoryPagination(args);
  const minimalOutput = optionalBoolean(args, 'minimal_output', true);
  const result = await ctx.client.search('/search/repositories', {
    query: defined({
      q: query,
      sort: optionalString(args, 'sort'),
      order: optionalString(args, 'order'),
      page,
    }),
    perPage,
    maxItems: page * perPage,
    signal: ctx.signal,
  });
  const rawItems = Array.isArray(result?.items) ? result.items : [];
  return {
    total_count: result?.total_count ?? 0,
    incomplete_results: result?.incomplete_results === true,
    items: rawItems.map((repo) => (minimalOutput ? minimalRepository(repo) : fullSearchRepository(repo))),
  };
}

// ---------------------------------------------------------------------------
// get_repository_tree
// ---------------------------------------------------------------------------

/** `get_repository_tree` — GET /repos/{owner}/{repo}/git/trees/{tree_sha}. */
async function getRepositoryTree(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  let treeSHA = optionalString(args, 'tree_sha');
  const recursive = optionalBoolean(args, 'recursive', false);
  const pathFilter = optionalString(args, 'path_filter');

  if (treeSHA === undefined) {
    const info = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}`, { signal: ctx.signal });
    treeSHA = info?.default_branch;
    if (typeof treeSHA !== 'string' || treeSHA === '') {
      fail(`failed to get repository info: no default branch for ${owner}/${repo}`);
    }
  }

  const tree = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/git/trees/${pathSeg(treeSHA)}`, {
    query: recursive ? { recursive: 1 } : undefined,
    signal: ctx.signal,
  });

  const allEntries = Array.isArray(tree?.entries) ? tree.entries : [];
  const filteredEntries =
    pathFilter === undefined
      ? allEntries
      : allEntries.filter((entry) => String(entry?.path ?? '').startsWith(pathFilter));

  return {
    sha: tree?.sha ?? '',
    truncated: tree?.truncated === true,
    tree: filteredEntries.map((entry) =>
      defined({
        path: entry?.path ?? '',
        type: entry?.type ?? '',
        size: entry?.size,
        mode: entry?.mode ?? '',
        sha: entry?.sha ?? '',
      }),
    ),
    tree_sha: treeSHA,
    owner,
    repo,
    recursive,
    count: filteredEntries.length,
  };
}

// ---------------------------------------------------------------------------
// list_repository_collaborators
// ---------------------------------------------------------------------------

/**
 * `list_repository_collaborators` — GET /repos/{owner}/{repo}/collaborators.
 *
 * NOTE: go-github derives `firstPage`/`lastPage`/`nextPage`/`prevPage` from the
 * `Link` response header; `client.get` does not expose headers, so the page
 * numbers are inferred from the page size and the returned item count.
 */
async function listRepositoryCollaborators(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const affiliation = optionalString(args, 'affiliation');
  const { page, perPage } = repositoryPagination(args);
  const collaborators = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/collaborators`, {
    query: defined({ affiliation, page, per_page: perPage }),
    signal: ctx.signal,
  });
  const list = Array.isArray(collaborators) ? collaborators : [];
  const items = list.map((collaborator) => {
    const source = collaborator !== null && typeof collaborator === 'object' ? collaborator : {};
    return { login: source.login ?? '', id: source.id ?? 0, role_name: source.role_name ?? '' };
  });
  const hasMore = list.length >= perPage;
  return {
    firstPage: page > 1 ? 1 : 0,
    items,
    lastPage: hasMore ? 0 : page,
    nextPage: hasMore ? page + 1 : 0,
    prevPage: page > 1 ? page - 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// get_file_blame (GraphQL)
// ---------------------------------------------------------------------------

/** Upstream `maxBlameRanges`. */
const MAX_BLAME_RANGES = 1000;
/** Upstream `blameCursorPrefix`. */
const BLAME_CURSOR_PREFIX = 'blame-range:';

/** Upstream `encodeBlameCursor` — base64 raw URL encoding of `blame-range:<offset>`. */
function encodeBlameCursor(offset) {
  return Buffer.from(`${BLAME_CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

/** Upstream `decodeBlameCursor`. */
function decodeBlameCursor(cursor) {
  if (cursor === undefined || cursor === '') return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(BLAME_CURSOR_PREFIX)) fail('after cursor is invalid');
  const offset = Number(decoded.slice(BLAME_CURSOR_PREFIX.length));
  if (!Number.isInteger(offset) || offset < 0) fail('after cursor is invalid');
  return offset;
}

/** Upstream `validateBlamePath`. */
function validateBlamePath(path) {
  if (String(path).trim() === '') fail('path must not be empty');
  if (path.startsWith('/')) fail("path must be relative to the repository root (no leading '/')");
  if (path.split('/').includes('..')) fail("path must not contain '..' segments");
  for (const char of path) {
    const code = char.codePointAt(0);
    if (code < 0x20 || code === 0x7f) fail('path must not contain control characters');
  }
}

/** The `Commit.blame` selection shared by the Commit and Tag branches. */
const BLAME_RANGES_SELECTION = `
              ranges {
                startingLine
                endingLine
                age
                commit {
                  oid
                  message
                  committedDate
                  author { name email user { login url } }
                }
              }`;

/** Upstream `GetFileBlame` GraphQL document. */
const BLAME_QUERY = `
  query($owner: String!, $repo: String!, $ref: String!, $path: String!) {
    repository(owner: $owner, name: $repo) {
      defaultBranchRef { name }
      object(expression: $ref) {
        __typename
        ... on Commit {
          blame(path: $path) {${BLAME_RANGES_SELECTION}
          }
        }
        ... on Tag {
          target {
            __typename
            ... on Commit {
              blame(path: $path) {${BLAME_RANGES_SELECTION}
              }
            }
          }
        }
      }
    }
  }`;

/** `get_file_blame` — GraphQL, with local cursor pagination over `Blame.ranges`. */
async function getFileBlame(args, ctx) {
  const { owner, repo } = ownerRepo(args);
  const path = requireParameter(args, 'path');
  validateBlamePath(path);
  const ref = optionalString(args, 'ref');

  const hasStartLine = args?.start_line !== undefined && args?.start_line !== null;
  const startLine = hasStartLine ? toPositiveInt(args.start_line, 0) : 0;
  if (hasStartLine && Number(args.start_line) < 1) fail('start_line must be omitted or >= 1');
  const hasEndLine = args?.end_line !== undefined && args?.end_line !== null;
  const endLine = hasEndLine ? toPositiveInt(args.end_line, 0) : 0;
  if (hasEndLine && Number(args.end_line) < 1) fail('end_line must be omitted or >= 1');
  if (hasStartLine && hasEndLine && Number(args.end_line) < Number(args.start_line)) {
    fail('end_line must be >= start_line when both are provided');
  }

  let perPage = 30;
  if (args?.perPage !== undefined && args?.perPage !== null) {
    const parsed = Number(args.perPage);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      fail('perPage must be between 1 and 100 when provided');
    }
    perPage = parsed;
  }
  const afterOffset = decodeBlameCursor(optionalString(args, 'after'));

  const refExpression = ref === undefined ? 'HEAD' : ref;
  const data = await ctx.client.graphql(
    BLAME_QUERY,
    { owner, repo, ref: refExpression, path },
    { signal: ctx.signal },
  );

  const object = data?.repository?.object;
  const objectTypename = object?.__typename;
  if (typeof objectTypename !== 'string' || objectTypename === '') {
    fail(`ref ${JSON.stringify(refExpression)} was not found in ${owner}/${repo}`);
  }
  let blameCommit = object;
  if (objectTypename === 'Tag') {
    const targetTypename = object?.target?.__typename ?? '';
    if (targetTypename !== 'Commit') {
      fail(
        `ref ${JSON.stringify(refExpression)} resolved to a tag in ${owner}/${repo}, but the tag target did not resolve to a commit (resolved to ${targetTypename === '' ? 'unknown' : targetTypename})`,
      );
    }
    blameCommit = object.target;
  } else if (objectTypename !== 'Commit') {
    fail(
      `ref ${JSON.stringify(refExpression)} did not resolve to a commit in ${owner}/${repo} (resolved to ${objectTypename})`,
    );
  }

  let responseRef = ref;
  if (responseRef === undefined) {
    const defaultName = data?.repository?.defaultBranchRef?.name;
    responseRef = typeof defaultName === 'string' && defaultName !== '' ? defaultName : refExpression;
  }

  const rawRanges = Array.isArray(blameCommit?.blame?.ranges) ? blameCommit.blame.ranges : [];
  const pageRanges = [];
  const commits = {};
  let totalRanges = 0;
  let truncated = false;

  for (const range of rawRanges) {
    let start = Number(range?.startingLine ?? 0);
    let end = Number(range?.endingLine ?? 0);
    if (startLine > 0 && end < startLine) continue;
    if (endLine > 0 && start > endLine) continue;
    if (startLine > 0 && start < startLine) start = startLine;
    if (endLine > 0 && end > endLine) end = endLine;

    const matchIndex = totalRanges;
    totalRanges += 1;
    if (matchIndex >= MAX_BLAME_RANGES) {
      truncated = true;
      continue;
    }
    if (matchIndex < afterOffset || pageRanges.length >= perPage) continue;

    const commit = range?.commit ?? {};
    const sha = commit.oid ?? '';
    pageRanges.push({ starting_line: start, ending_line: end, age: Number(range?.age ?? 0), commit_sha: sha });

    if (Object.hasOwn(commits, sha)) continue;
    let headline = String(commit.message ?? '');
    const newline = headline.indexOf('\n');
    if (newline >= 0) headline = headline.slice(0, newline);
    headline = headline.replace(/[ \t\r]+$/, '');
    const entry = {
      sha,
      message_headline: sanitizePlainText(headline),
      committed_date: formatRFC3339(commit.committedDate),
      author: defined({
        name: commit.author?.name ?? '',
        email: commit.author?.email ?? '',
      }),
    };
    if (commit.author?.user !== null && typeof commit.author?.user === 'object') {
      entry.author.login = commit.author.user.login ?? '';
      entry.author.url = commit.author.user.url ?? '';
    }
    commits[sha] = entry;
  }

  const cappedRanges = Math.min(totalRanges, MAX_BLAME_RANGES);
  const consumedRanges = Math.min(afterOffset + pageRanges.length, cappedRanges);
  const pageInfo = {
    hasNextPage: consumedRanges < cappedRanges,
    hasPreviousPage: afterOffset > 0,
  };
  if (pageRanges.length > 0) {
    pageInfo.startCursor = encodeBlameCursor(afterOffset);
    pageInfo.endCursor = encodeBlameCursor(consumedRanges);
  }

  return defined({
    repository: `${owner}/${repo}`,
    path,
    ref: responseRef,
    ranges: pageRanges,
    commits,
    pageInfo,
    total_ranges: totalRanges,
    truncated: truncated ? true : undefined,
  });
}

export default {
  create_branch: createBranch,
  create_or_update_file: createOrUpdateFile,
  create_repository: createRepository,
  delete_file: deleteFile,
  delete_repository: deleteRepository,
  fork_repository: forkRepository,
  get_commit: getCommit,
  get_file_blame: getFileBlame,
  get_file_contents: getFileContents,
  get_latest_release: getLatestRelease,
  get_release_by_tag: getReleaseByTag,
  get_tag: getTag,
  list_branches: listBranches,
  list_commits: listCommits,
  list_releases: listReleases,
  list_repository_collaborators: listRepositoryCollaborators,
  list_tags: listTags,
  push_files: pushFiles,
  search_code: searchCode,
  search_commits: searchCommits,
  search_repositories: searchRepositories,
  get_repository_tree: getRepositoryTree,
  list_starred_repositories: listStarredRepositories,
  star_repository: starRepository,
  unstar_repository: unstarRepository,
};

/**
 * gists.js — 4 tool handlers.
 *
 *   - create_gist
 *   - get_gist
 *   - list_gists
 *   - update_gist
 *
 * Ported from the upstream Go server:
 *   pkg/github/gists.go          (ListGists, GetGist, CreateGist, UpdateGist)
 *   pkg/github/git_gist_types.go (GistOutput / GistFileOutput projections and the
 *                                 legacy argument validation)
 */

import { defined, fail, optionalBoolean, optionalString, paginationQuery, requireString, seg } from '../util.js';

/** `parseISOTimestamp` (issues.go) — the two accepted shapes. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `parseISOTimestamp` — normalize an RFC3339 or `YYYY-MM-DD` timestamp.
 * @returns {string} the RFC3339 rendering
 */
function parseIsoTimestamp(value) {
  if (value === '') fail('empty timestamp');
  if (RFC3339.test(value)) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return `${parsed.toISOString().replace(/\.\d+Z$/, '')}Z`;
  } else if (DATE_ONLY.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime())) return `${value}T00:00:00Z`;
  }
  fail(`invalid ISO 8601 timestamp: ${value} (supported formats: YYYY-MM-DDThh:mm:ssZ or YYYY-MM-DD)`);
  return '';
}

/** `time.RFC3339Nano` — the fractional part trimmed, and dropped when all zeros. */
function rfc3339Nano(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return value;
  const fraction = (match[2] ?? '').replace(/0+$/, '');
  return fraction.length > 0 ? `${match[1]}.${fraction}${match[3]}` : `${match[1]}${match[3]}`;
}

/** `convertToMinimalUser` — `Details` is deliberately never populated. */
function minimalUser(user) {
  if (!user) return undefined;
  const out = { login: user.login ?? '' };
  if (user.id) out.id = user.id;
  if (user.html_url) out.profile_url = user.html_url;
  if (user.avatar_url) out.avatar_url = user.avatar_url;
  return out;
}

/** `GistFileOutput`. */
function gistFile(file) {
  return defined({
    filename: file?.filename,
    content: file?.content,
    size: file?.size,
    language: file?.language,
    type: file?.type,
    raw_url: file?.raw_url,
  });
}

/** `projectGist` — the trimmed gist every gist tool returns. */
function projectGist(gist) {
  if (!gist) return null;
  const files = {};
  for (const [name, file] of Object.entries(gist.files ?? {})) files[name] = gistFile(file);
  return defined({
    id: gist.id,
    description: gist.description,
    public: gist.public,
    owner: minimalUser(gist.owner),
    files: Object.keys(files).length > 0 ? files : undefined,
    comments: gist.comments,
    html_url: gist.html_url,
    git_pull_url: gist.git_pull_url,
    created_at: rfc3339Nano(gist.created_at),
    updated_at: rfc3339Nano(gist.updated_at),
  });
}

/** `list_gists` — GET /gists, or GET /users/{username}/gists. */
async function listGists(args, ctx) {
  const username = optionalString(args, 'username');
  const since = optionalString(args, 'since');
  const { page, per_page } = paginationQuery(args, { defaultPerPage: 30 });
  const query = {
    since: since === undefined ? undefined : parseIsoTimestamp(since),
    page,
    per_page,
  };
  const path = username === undefined ? '/gists' : `/users/${seg(username)}/gists`;
  const gists = await ctx.client.get(path, { query, signal: ctx.signal });
  const list = Array.isArray(gists) ? gists : [];
  return list.map((gist) => projectGist(gist));
}

/** `get_gist` — GET /gists/{gist_id}; the bare GistOutput is returned, not wrapped. */
async function getGist(args, ctx) {
  const gistId = requireString(args, 'gist_id');
  const gist = await ctx.client.get(`/gists/${seg(gistId)}`, { signal: ctx.signal });
  // The upstream MarshalJSON emits `null` for a nil gist; the handler contract
  // forbids returning null, so an empty 200 is reported as an error instead.
  if (!gist) fail('failed to get gist: empty response');
  return projectGist(gist);
}

/** `create_gist` — POST /gists. */
async function createGist(args, ctx) {
  const description = optionalString(args, 'description') ?? '';
  const filename = requireString(args, 'filename');
  const content = requireString(args, 'content');
  const isPublic = optionalBoolean(args, 'public', false) === true;

  const gist = await ctx.client.post(
    '/gists',
    { files: { [filename]: { content } }, public: isPublic, description },
    { signal: ctx.signal },
  );
  return { id: gist?.id ?? '', url: gist?.html_url ?? '' };
}

/** `update_gist` — PATCH /gists/{gist_id}. */
async function updateGist(args, ctx) {
  const gistId = requireString(args, 'gist_id');
  const filename = requireString(args, 'filename');
  const content = requireString(args, 'content');

  const body = { files: { [filename]: { filename, content } } };
  // Only send `description` when the caller supplied it, so omitting the key
  // preserves the gist's existing description; an explicit "" clears it.
  if (Object.prototype.hasOwnProperty.call(args ?? {}, 'description')) {
    body.description = optionalString(args, 'description') ?? '';
  }

  const gist = await ctx.client.patch(`/gists/${seg(gistId)}`, body, { signal: ctx.signal });
  return { id: gist?.id ?? '', url: gist?.html_url ?? '' };
}

export default {
  create_gist: createGist,
  get_gist: getGist,
  list_gists: listGists,
  update_gist: updateGist,
};

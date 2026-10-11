/**
 * context.js — 6 tool handlers.
 *
 *   - get_me
 *   - get_teams
 *   - get_team_members
 *   - ui_get
 *   - search_users
 *   - search_orgs
 *
 * This module is the reference implementation for the other handler files:
 * a handler is `async (args, ctx) => plainObject`, it never touches the harness
 * (registration, schemas and rendering are the entry module's job), and it
 * returns JSON-serializable data only.
 *
 * Ported from the upstream Go server:
 *   pkg/github/context_tools.go (get_me, get_teams, get_team_members)
 *   pkg/github/ui_tools.go      (ui_get)
 *   pkg/github/search.go        (search_users, search_orgs)
 */

import { fail, listResult, optionalString, paginationQuery, requireEnum, requireString, seg } from '../util.js';

/** `ui_get` bounds each pagination loop, matching the upstream `uiGetMaxPages`. */
const UI_GET_MAX_PAGES = 10;

/** The minimal user shape the upstream server returns for `get_me`. */
function minimalUser(user) {
  if (!user) return null;
  return {
    login: user.login,
    id: user.id,
    profile_url: user.html_url,
    avatar_url: user.avatar_url,
    details: {
      name: user.name,
      company: user.company,
      blog: user.blog,
      location: user.location,
      email: user.email,
      hireable: user.hireable,
      bio: user.bio,
      twitter_username: user.twitter_username,
      public_repos: user.public_repos,
      public_gists: user.public_gists,
      followers: user.followers,
      following: user.following,
      created_at: user.created_at,
      updated_at: user.updated_at,
      private_gists: user.private_gists,
      total_private_repos: user.total_private_repos,
      owned_private_repos: user.owned_private_repos,
    },
  };
}

/** `get_me` — GET /user. */
async function getMe(_args, ctx) {
  const user = await ctx.client.get('/user', { signal: ctx.signal });
  if (!user) fail('failed to get user: empty response');
  return minimalUser(user);
}

/** `get_teams` — the user's teams, grouped by organization (GraphQL). */
async function getTeams(args, ctx) {
  let username = optionalString(args, 'user');
  if (username === undefined) {
    const me = await ctx.client.get('/user', { signal: ctx.signal });
    username = me?.login;
  }
  if (!username) fail('failed to resolve the authenticated user login');

  const query = `
    query($login: String!) {
      user(login: $login) {
        organizations(first: 100) {
          nodes {
            login
            teams(first: 100, userLogins: [$login]) {
              nodes { name slug description }
            }
          }
        }
      }
    }`;
  const data = await ctx.client.graphql(query, { login: username }, { signal: ctx.signal });
  const organizations = [];
  for (const org of data?.user?.organizations?.nodes ?? []) {
    organizations.push({
      org: org.login,
      teams: (org.teams?.nodes ?? []).map((team) => ({
        name: team.name,
        slug: team.slug,
        description: team.description,
      })),
    });
  }
  return organizations;
}

/** `get_team_members` — member logins of one team (GraphQL). */
async function getTeamMembers(args, ctx) {
  const org = requireString(args, 'org');
  const teamSlug = requireString(args, 'team_slug', ['teamSlug']);
  const query = `
    query($org: String!, $slug: String!) {
      organization(login: $org) {
        team(slug: $slug) {
          name
          slug
          members(first: 100) {
            nodes { login }
          }
        }
      }
    }`;
  const data = await ctx.client.graphql(query, { org, slug: teamSlug }, { signal: ctx.signal });
  // Upstream returns an empty list rather than an error when the team has no members
  // (context_tools.go: `var members []string` … `if members == nil { members = []string{} }`).
  const team = data?.organization?.team;
  if (!team) return [];
  return (team.members?.nodes ?? []).map((member) => member.login);
}

/** Fetch up to `maxPages * 100` items, reporting whether the cap cut it short. */
async function collect(client, path, { query = {}, signal, maxPages = UI_GET_MAX_PAGES } = {}) {
  const items = [];
  let page = 1;
  let hasMore = false;
  for (;;) {
    const batch = await client.get(path, { query: { ...query, per_page: 100, page }, signal });
    if (!Array.isArray(batch)) break;
    items.push(...batch);
    if (batch.length < 100) break;
    if (page >= maxPages) {
      hasMore = true;
      break;
    }
    page += 1;
  }
  return { items, hasMore };
}

/** `ui_get` — data for the MCP App pickers (labels, assignees, milestones, …). */
async function uiGet(args, ctx) {
  const method = requireEnum(
    requireString(args, 'method'),
    ['labels', 'assignees', 'milestones', 'issue_types', 'branches', 'issue_fields', 'reviewers'],
    'method',
  );
  const owner = requireString(args, 'owner');
  const repo = optionalString(args, 'repo');
  if (method !== 'issue_types' && repo === undefined) fail('missing required argument: repo');
  // Upstream's output is `UIGetOutput{method, <method>: <payload>}`: the method name is both
  // a discriminator and the key its payload is nested under (typed_copilot_ui_outputs.go:280).
  return { method, [method]: await uiGetPayload(method, ctx, owner, repo) };
}

/** The per-method `ui_get` payload, nested under the method key. */
async function uiGetPayload(method, ctx, owner, repo) {
  switch (method) {
    case 'labels': {
      const query = `
        query($owner: String!, $name: String!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            labels(first: 100, after: $cursor) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes { id name color description }
            }
          }
        }`;
      const labels = [];
      let cursor = null;
      let totalCount = 0;
      let hasMore = false;
      for (let page = 1; ; page += 1) {
        const data = await ctx.client.graphql(query, { owner, name: repo, cursor }, { signal: ctx.signal });
        const connection = data?.repository?.labels;
        for (const label of connection?.nodes ?? []) {
          labels.push({
            id: String(label.id),
            name: label.name,
            color: label.color,
            description: label.description,
          });
        }
        totalCount = connection?.totalCount ?? labels.length;
        if (!connection?.pageInfo?.hasNextPage) break;
        if (page >= UI_GET_MAX_PAGES) {
          hasMore = true;
          break;
        }
        cursor = connection.pageInfo.endCursor;
      }
      return { labels, totalCount, has_more: hasMore };
    }
    case 'assignees': {
      const { items, hasMore } = await collect(ctx.client, `/repos/${seg(owner)}/${seg(repo)}/assignees`, { signal: ctx.signal });
      const assignees = items.map((user) => ({ login: user.login, avatar_url: user.avatar_url }));
      return { assignees, totalCount: assignees.length, has_more: hasMore };
    }
    case 'milestones': {
      const { items, hasMore } = await collect(ctx.client, `/repos/${seg(owner)}/${seg(repo)}/milestones`, {
        query: { state: 'open' },
        signal: ctx.signal,
      });
      const milestones = items.map((milestone) => ({
        number: milestone.number,
        title: milestone.title,
        description: milestone.description,
        state: milestone.state,
        open_issues: milestone.open_issues,
        due_on: milestone.due_on ? String(milestone.due_on).slice(0, 10) : '',
      }));
      return { milestones, totalCount: milestones.length, has_more: hasMore };
    }
    case 'issue_types': {
      const types = await ctx.client.get(`/orgs/${seg(owner)}/issue-types`, { signal: ctx.signal });
      // `issue_types` is the one method whose payload is a bare array (UIGetOutput.IssueTypes).
      return Array.isArray(types) ? types : [];
    }
    case 'branches': {
      const { items, hasMore } = await collect(ctx.client, `/repos/${seg(owner)}/${seg(repo)}/branches`, { signal: ctx.signal });
      const branches = items.map((branch) => ({ name: branch.name, sha: branch.commit?.sha, protected: branch.protected }));
      return { branches, totalCount: branches.length, has_more: hasMore };
    }
    case 'issue_fields': {
      const query = `
        query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            issueFields(first: 100) {
              nodes {
                __typename
                ... on IssueFieldSingleSelect {
                  id name description dataType visibility
                  options(first: 100) { nodes { id name description color } }
                }
                ... on IssueFieldText { id name description dataType visibility }
                ... on IssueFieldNumber { id name description dataType visibility }
                ... on IssueFieldDate { id name description dataType visibility }
              }
            }
          }
        }`;
      const data = await ctx.client.graphql(query, { owner, name: repo }, { signal: ctx.signal });
      const supported = new Set(['text', 'number', 'date', 'single_select']);
      const fields = [];
      for (const node of data?.repository?.issueFields?.nodes ?? []) {
        const dataType = node.dataType;
        if (!supported.has(dataType)) continue;
        const field = { id: String(node.id), name: node.name, data_type: dataType, description: node.description };
        if (dataType === 'single_select') {
          field.options = (node.options?.nodes ?? []).map((option) => ({
            name: option.name,
            description: option.description,
            color: option.color,
          }));
        }
        fields.push(field);
      }
      return { fields, totalCount: fields.length };
    }
    case 'reviewers': {
      const collaborators = await collect(ctx.client, `/repos/${seg(owner)}/${seg(repo)}/collaborators`, {
        query: { affiliation: 'all' },
        signal: ctx.signal,
      });
      const teams = await collect(ctx.client, `/repos/${seg(owner)}/${seg(repo)}/teams`, { signal: ctx.signal });
      const users = collaborators.items
        .filter((user) => user.type !== 'Bot' && !String(user.login ?? '').endsWith('[bot]'))
        .map((user) => ({ login: user.login, avatar_url: user.avatar_url }));
      const reviewerTeams = teams.items.map((team) => ({ slug: team.slug, name: team.name, org: owner }));
      return {
        users,
        teams: reviewerTeams,
        totalCount: users.length + reviewerTeams.length,
        has_more: collaborators.hasMore || teams.hasMore,
      };
    }
    default:
      fail(`unknown method: ${method}`);
      return {};
  }
}

/** Shared body for `search_users` / `search_orgs` (REST /search/users). */
async function searchAccounts(args, ctx, accountType) {
  const query = requireString(args, 'query');
  const { page, per_page } = paginationQuery(args, { defaultPerPage: 30 });
  const scoped = /(^|\s)type:/i.test(query) ? query : `type:${accountType} ${query}`;
  const result = await ctx.client.search('/search/users', {
    query: {
      q: scoped,
      sort: optionalString(args, 'sort'),
      order: optionalString(args, 'order'),
      page,
      per_page,
    },
    maxItems: page * per_page,
    signal: ctx.signal,
  });
  const items = (result.items ?? [])
    .filter((user) => user?.login)
    .map((user) => ({
      login: user.login,
      id: user.id,
      profile_url: user.html_url,
      avatar_url: user.avatar_url,
    }));
  return {
    ...listResult(items, { page, perPage: per_page, totalCount: result.total_count }),
    incomplete_results: result.incomplete_results,
  };
}

/** `search_users` — REST /search/users scoped to `type:user`. */
function searchUsers(args, ctx) {
  return searchAccounts(args, ctx, 'user');
}

/** `search_orgs` — REST /search/users scoped to `type:org`. */
function searchOrgs(args, ctx) {
  return searchAccounts(args, ctx, 'org');
}

export default {
  get_me: getMe,
  get_teams: getTeams,
  get_team_members: getTeamMembers,
  ui_get: uiGet,
  search_users: searchUsers,
  search_orgs: searchOrgs,
};

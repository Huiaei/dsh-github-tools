/**
 * issues.js — 16 tool handlers.
 *
 *   - create_issue
 *   - issue_read
 *   - issue_write
 *   - list_issues
 *   - list_issue_types
 *   - list_issue_fields
 *   - add_issue_comment
 *   - update_issue_comment
 *   - sub_issue_write
 *   - add_sub_issue
 *   - remove_sub_issue
 *   - reprioritize_sub_issue
 *   - issue_dependency_read
 *   - issue_dependency_write
 *   - find_duplicate
 *   - search_issues
 *
 * Ported from the upstream Go server:
 *   pkg/github/issues.go            (issue_read, issue_write, list_issues,
 *                                    list_issue_types, add_issue_comment,
 *                                    update_issue_comment, sub_issue_write,
 *                                    search_issues)
 *   pkg/github/issues_granular.go   (create_issue, add_sub_issue,
 *                                    remove_sub_issue, reprioritize_sub_issue)
 *   pkg/github/issue_fields.go      (list_issue_fields)
 *   pkg/github/issue_dependencies.go(issue_dependency_read/write)
 *   pkg/github/find_duplicate.go    (find_duplicate)
 *   pkg/github/search_utils.go      (search query munging)
 *   pkg/github/minimal_types.go     (the minimal shapes every handler returns)
 *
 * Outputs mirror the typed "structured content" the upstream handlers return
 * (IssueDetailsOutput, SubIssueOutput, ListIssuesOutput, SearchIssuesOutput, …),
 * which is also what `src/generated/tools.json` advertises as the output schema.
 */

import {
  fail,
  listResult,
  optionalString,
  paginationQuery,
  requireEnum,
  requireString,
  seg,
  toPositiveInt,
} from '../util.js';
import { nextLink } from '../client.js';

/* ------------------------------------------------------------------ */
/* GraphQL documents                                                    */
/* ------------------------------------------------------------------ */

/** `name` on each concrete member of the IssueField union (reading values). */
const FIELD_REF_NAME = `
  ... on IssueFieldDate { name }
  ... on IssueFieldNumber { name }
  ... on IssueFieldSingleSelect { name }
  ... on IssueFieldText { name }`;

/** `name` + `fullDatabaseId` on each member (resolving a write target). */
const FIELD_REF_FULL = `
  ... on IssueFieldDate { name fullDatabaseId }
  ... on IssueFieldNumber { name fullDatabaseId }
  ... on IssueFieldSingleSelect { name fullDatabaseId }
  ... on IssueFieldText { name fullDatabaseId }`;

/** `issueFieldValues(first: 25)` with the four concrete value variants. */
function issueFieldValuesSelection(ref) {
  return `issueFieldValues(first: 25) {
          nodes {
            __typename
            ... on IssueFieldDateValue { value field { ${ref} } }
            ... on IssueFieldNumberValue { valueNumber: value field { ${ref} } }
            ... on IssueFieldSingleSelectValue { value field { ${ref} } }
            ... on IssueFieldTextValue { value field { ${ref} } }
          }
        }`;
}

/**
 * The `issue_read` `get` enrichment: custom field values, the parent
 * reference, the closing pull requests and the sub-issue summary, all in one
 * `nodes(ids:)` round-trip.
 */
const ISSUE_READ_ENRICHMENT_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue {
        id
        ${issueFieldValuesSelection(FIELD_REF_NAME)}
        parent {
          number
          title
          state
          url
          author { login }
          repository { nameWithOwner }
        }
        closedByPullRequestsReferences(first: 5, includeClosedPrs: true, orderByState: true) {
          totalCount
          nodes {
            number
            title
            state
            url
            author { login }
            repository { nameWithOwner }
          }
        }
        subIssuesSummary { total completed percentCompleted }
      }
    }
  }`;

/** The `search_issues` field-value enrichment (one nodes() round-trip). */
const SEARCH_ISSUE_FIELD_VALUES_QUERY = `
  query($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Issue {
        id
        ${issueFieldValuesSelection(FIELD_REF_FULL)}
      }
    }
  }`;

const ISSUE_FIELDS_REPO_QUERY = `
  query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) {
      issueFields(first: 100) {
        nodes {
          __typename
          ... on IssueFieldSingleSelect {
            id fullDatabaseId name description dataType visibility
            options { id name description color priority }
          }
          ... on IssueFieldText { id fullDatabaseId name description dataType visibility }
          ... on IssueFieldNumber { id fullDatabaseId name description dataType visibility }
          ... on IssueFieldDate { id fullDatabaseId name description dataType visibility }
        }
      }
    }
  }`;

const ISSUE_FIELDS_ORG_QUERY = `
  query($login: String!) {
    organization(login: $login) {
      issueFields(first: 100) {
        nodes {
          __typename
          ... on IssueFieldSingleSelect {
            id fullDatabaseId name description dataType visibility
            options { id name description priority }
          }
          ... on IssueFieldText { id fullDatabaseId name description dataType visibility }
          ... on IssueFieldNumber { id fullDatabaseId name description dataType visibility }
          ... on IssueFieldDate { id fullDatabaseId name description dataType visibility }
        }
      }
    }
  }`;

const ISSUE_FIELD_WRITE_METADATA_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      issueFields(first: 100) {
        nodes {
          __typename
          ... on IssueFieldText { fullDatabaseId name dataType }
          ... on IssueFieldNumber { fullDatabaseId name dataType }
          ... on IssueFieldDate { fullDatabaseId name dataType }
          ... on IssueFieldSingleSelect {
            fullDatabaseId name dataType
            options { fullDatabaseId name }
          }
        }
      }
    }
  }`;

const EXISTING_ISSUE_FIELD_VALUES_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) {
        ${issueFieldValuesSelection(FIELD_REF_FULL)}
      }
    }
  }`;

const CREATE_ISSUE_MUTATION = `
  mutation($input: CreateIssueInput!) {
    createIssue(input: $input) {
      issue { fullDatabaseId url }
    }
  }`;

const CREATE_ISSUE_PARENT_METADATA_QUERY = `
  query($owner: String!, $repo: String!, $parentOwner: String!, $parentRepo: String!, $parentIssueNumber: Int!) {
    childRepository: repository(owner: $owner, name: $repo) { id nameWithOwner }
    parentRepository: repository(owner: $parentOwner, name: $parentRepo) {
      issue(number: $parentIssueNumber) { id number }
    }
  }`;

const USER_ID_QUERY = `
  query($login: String!) {
    user(login: $login) { id login }
  }`;

const MILESTONE_ID_QUERY = `
  query($owner: String!, $repo: String!, $milestoneNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      milestone(number: $milestoneNumber) { id number }
    }
  }`;

const LABEL_ID_QUERY = `
  query($owner: String!, $repo: String!, $name: String!) {
    repository(owner: $owner, name: $repo) {
      label(name: $name) { id name }
    }
  }`;

const ISSUE_PARENT_QUERY = `
  query($owner: String!, $repo: String!, $issueNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        parent {
          number
          title
          state
          url
          author { login }
          repository { nameWithOwner }
        }
      }
    }
  }`;

const ISSUE_LABELS_QUERY = `
  query($owner: String!, $repo: String!, $issueNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) {
        labels(first: 100) {
          totalCount
          nodes { id name color description }
        }
      }
    }
  }`;

const ISSUE_ID_QUERY = `
  query($owner: String!, $repo: String!, $issueNumber: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) { id }
    }
  }`;

const ISSUE_AND_DUPLICATE_ID_QUERY = `
  query($owner: String!, $repo: String!, $issueNumber: Int!, $duplicateOf: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $issueNumber) { id }
      duplicateIssue: issue(number: $duplicateOf) { id }
    }
  }`;

const REOPEN_ISSUE_MUTATION = `
  mutation($input: ReopenIssueInput!) {
    reopenIssue(input: $input) { issue { id number url state } }
  }`;

const CLOSE_ISSUE_MUTATION = `
  mutation($input: CloseIssueInput!) {
    closeIssue(input: $input) { issue { id number url state } }
  }`;

/* ------------------------------------------------------------------ */
/* Argument helpers                                                     */
/* ------------------------------------------------------------------ */

/** A required integer argument (accepts `7` and `"7.0"`, as the Go normalizers do). */
function requireInt(args, key, aliases = []) {
  for (const name of [key, ...aliases]) {
    const value = args?.[name];
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  fail(`missing required argument: ${key}`);
  return undefined;
}

/** An optional integer argument (`undefined` when absent). */
function optionalInt(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

/** Whether the caller explicitly supplied a (possibly null) key. */
function hasArg(args, key) {
  return Object.prototype.hasOwnProperty.call(args ?? {}, key) && args[key] !== undefined;
}

/** A string array argument; `provided` distinguishes `[]` from "absent". */
function stringArrayArg(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null) return { values: [], provided: false };
  if (!Array.isArray(value)) fail(`${key} must be an array of strings`);
  return { values: value.map((entry) => String(entry)), provided: true };
}

/* ------------------------------------------------------------------ */
/* Minimal output shapes (pkg/github/minimal_types.go)                  */
/* ------------------------------------------------------------------ */

/** `MinimalUser` — {login, id, profile_url, avatar_url}. */
function minimalUser(user) {
  if (!user) return null;
  const out = { login: user.login ?? '' };
  if (user.id) out.id = user.id;
  if (user.html_url) out.profile_url = user.html_url;
  if (user.avatar_url) out.avatar_url = user.avatar_url;
  return out;
}

/** `IssueUserOutput` — the trimmed {login, id} used by issue_read/issue_write. */
function issueUserOutput(user) {
  if (!user || !user.login) return null;
  const out = { login: user.login };
  if (user.id) out.id = user.id;
  return out;
}

/** `MinimalReactions` — drops the API URL. */
function minimalReactions(reactions) {
  if (!reactions) return null;
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

/** Label names from a REST label array (objects or bare strings). */
function labelNames(labels) {
  return (labels ?? []).filter(Boolean).map((label) => (typeof label === 'string' ? label : label.name));
}

/** `convertToMinimalIssue` — REST issue → the internal minimal shape. */
function minimalIssueFromRest(issue) {
  return {
    number: issue?.number ?? 0,
    title: issue?.title ?? '',
    body: issue?.body ?? '',
    state: issue?.state ?? '',
    state_reason: issue?.state_reason ?? '',
    draft: Boolean(issue?.draft),
    locked: Boolean(issue?.locked),
    html_url: issue?.html_url ?? '',
    user: minimalUser(issue?.user),
    author_association: issue?.author_association ?? '',
    labels: labelNames(issue?.labels),
    assignees: (issue?.assignees ?? []).filter(Boolean).map((assignee) => assignee.login),
    milestone: issue?.milestone?.title ?? '',
    comments: issue?.comments ?? 0,
    reactions: minimalReactions(issue?.reactions),
    created_at: issue?.created_at ?? '',
    updated_at: issue?.updated_at ?? '',
    closed_at: issue?.closed_at ?? '',
    closed_by: issue?.closed_by?.login ?? '',
    issue_type: issue?.type?.name ?? '',
    field_values: undefined,
    has_parent: undefined,
    has_children: undefined,
    parent: undefined,
    sub_issues_summary: undefined,
    closed_by_pull_requests: undefined,
  };
}

/**
 * `IssueDetailsOutput` — the structured `issue_read`/`get` shape. Field order
 * and `omitempty` semantics follow the Go struct declaration.
 */
function issueDetailsOutput(issue) {
  const out = {};
  out.number = issue.number;
  out.title = issue.title;
  if (issue.body) out.body = issue.body;
  out.state = issue.state;
  if (issue.state_reason) out.state_reason = issue.state_reason;
  if (issue.draft) out.draft = true;
  if (issue.locked) out.locked = true;
  if (issue.html_url) out.html_url = issue.html_url;
  const user = issueUserOutput(issue.user);
  if (user) out.user = user;
  if (issue.author_association) out.author_association = issue.author_association;
  if (issue.labels?.length) out.labels = issue.labels;
  out.assignees = issue.assignees;
  if (issue.milestone) out.milestone = issue.milestone;
  if (issue.comments) out.comments = issue.comments;
  if (issue.reactions) out.reactions = issue.reactions;
  if (issue.created_at) out.created_at = issue.created_at;
  if (issue.updated_at) out.updated_at = issue.updated_at;
  if (issue.closed_at) out.closed_at = issue.closed_at;
  if (issue.closed_by) out.closed_by = issue.closed_by;
  if (issue.issue_type) out.issue_type = issue.issue_type;
  if (issue.field_values?.length) out.field_values = issue.field_values;
  if (issue.has_parent !== undefined) out.has_parent = issue.has_parent;
  if (issue.has_children !== undefined) out.has_children = issue.has_children;
  if (issue.parent) out.parent = issue.parent;
  if (issue.sub_issues_summary) out.sub_issues_summary = issue.sub_issues_summary;
  if (issue.closed_by_pull_requests) out.closed_by_pull_requests = issue.closed_by_pull_requests;
  return out;
}

/** `IssueReadCommentOutput` — the structured comment shape. */
function issueCommentOutput(comment) {
  const out = {};
  if (comment.id !== undefined && comment.id !== null) out.id = comment.id;
  if (comment.body) out.body = comment.body;
  out.html_url = comment.html_url ?? '';
  const user = issueUserOutput(comment.user);
  if (user) out.user = user;
  if (comment.author_association) out.author_association = comment.author_association;
  if (comment.reactions) out.reactions = comment.reactions;
  if (comment.created_at) out.created_at = comment.created_at;
  if (comment.updated_at) out.updated_at = comment.updated_at;
  return out;
}

/** `convertToMinimalIssueComment` for a REST issue comment. */
function minimalCommentFromRest(comment) {
  return {
    id: comment?.id,
    body: comment?.body ?? '',
    html_url: comment?.html_url ?? '',
    user: minimalUser(comment?.user),
    author_association: comment?.author_association ?? '',
    reactions: minimalReactions(comment?.reactions),
    created_at: comment?.created_at ?? '',
    updated_at: comment?.updated_at ?? '',
  };
}

/** `SubIssueOutput` — the structured sub-issue shape. */
function subIssueOutput(issue) {
  if (!issue) return null;
  const minimal = minimalIssueFromRest(issue);
  const out = {};
  if (issue.id !== undefined && issue.id !== null) out.id = issue.id;
  if (issue.number !== undefined && issue.number !== null) out.number = issue.number;
  if (issue.title !== undefined && issue.title !== null) out.title = issue.title;
  if (issue.body !== undefined && issue.body !== null) out.body = issue.body;
  if (issue.state !== undefined && issue.state !== null) out.state = issue.state;
  if (issue.state_reason !== undefined && issue.state_reason !== null) out.state_reason = issue.state_reason;
  if (issue.html_url !== undefined && issue.html_url !== null) out.html_url = issue.html_url;
  const user = issueUserOutput(minimal.user);
  if (user) out.user = user;
  if (minimal.labels.length > 0) out.labels = minimal.labels;
  out.assignees = minimal.assignees;
  if (minimal.milestone) out.milestone = minimal.milestone;
  if (issue.comments) out.comments = issue.comments;
  if (minimal.created_at) out.created_at = minimal.created_at;
  if (minimal.updated_at) out.updated_at = minimal.updated_at;
  if (minimal.closed_at) out.closed_at = minimal.closed_at;
  if (minimal.issue_type) out.issue_type = minimal.issue_type;
  if (issue.sub_issues_summary) {
    out.sub_issues_summary = {
      total: issue.sub_issues_summary.total ?? 0,
      completed: issue.sub_issues_summary.completed ?? 0,
      percent_completed: issue.sub_issues_summary.percent_completed ?? 0,
    };
  }
  if (Array.isArray(issue.issue_field_values) && issue.issue_field_values.length > 0) {
    out.field_values = issue.issue_field_values.map((field) => ({
      issue_field_id: field?.issue_field_id,
      data_type: field?.data_type,
      value: field?.value ?? null,
    }));
  }
  return out;
}

/** `MinimalIssueRef` / `MinimalPullRequestRef` — {number,title,state,url,repository}. */
function issueRef({ number, title, state, url, repository }) {
  const out = { number: number ?? 0, title: title ?? '', state: state ?? '', url: url ?? '' };
  if (repository) out.repository = repository;
  return out;
}

/** `IssueLabelOutput`. */
function issueLabelOutput(label) {
  return {
    color: label?.color ?? '',
    description: label?.description ?? '',
    id: String(label?.id ?? ''),
    name: label?.name ?? '',
  };
}

/** `IssueTypeOutput`. */
function issueTypeOutput(type) {
  const out = {};
  if (type?.id !== undefined && type?.id !== null) out.id = type.id;
  if (type?.name !== undefined && type?.name !== null) out.name = type.name;
  if (type?.description !== undefined && type?.description !== null) out.description = type.description;
  if (type?.color !== undefined && type?.color !== null) out.color = type.color;
  if (type?.is_enabled !== undefined && type?.is_enabled !== null) out.is_enabled = type.is_enabled;
  return out;
}

/** `parseRepositoryURL` — "https://api.github.com/repos/o/r" → "o/r". */
function repositoryFromUrl(url) {
  if (typeof url !== 'string') return '';
  const match = /\/repos\/([^/]+)\/([^/]+)\/?$/.exec(url);
  if (!match) return '';
  return `${match[1]}/${match[2]}`;
}

/** `issueToDependencyRef` — REST issue → dependency reference (state uppercased). */
function dependencyRef(issue) {
  return issueRef({
    number: issue?.number ?? 0,
    title: issue?.title ?? '',
    state: String(issue?.state ?? '').toUpperCase(),
    url: issue?.html_url ?? '',
    repository: repositoryFromUrl(issue?.repository_url),
  });
}

/** `IssueSingleSelectFieldOption` — `description`/`priority` are `omitempty`. */
function issueFieldOption(option) {
  const out = { id: option.id, name: option.name };
  if (option.description) out.description = option.description;
  out.color = option.color;
  if (option.priority !== undefined && option.priority !== null) out.priority = option.priority;
  return out;
}

/** `parseFullDatabaseID` — a BigInt scalar string → number (0 when unparseable). */
function parseFullDatabaseId(value) {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* ------------------------------------------------------------------ */
/* GraphQL helpers                                                      */
/* ------------------------------------------------------------------ */

/** Flatten `issueFieldValues.nodes` into `[{field, value}]`. */
function fieldValuesFromNodes(nodes) {
  const out = [];
  for (const node of nodes ?? []) {
    const name = node?.field?.name;
    if (!name) continue;
    switch (node.__typename) {
      case 'IssueFieldDateValue':
        out.push({ field: name, value: String(node.value ?? '') });
        break;
      case 'IssueFieldNumberValue':
        out.push({ field: name, value: String(node.valueNumber ?? '') });
        break;
      case 'IssueFieldSingleSelectValue':
        out.push({ field: name, value: String(node.value ?? '') });
        break;
      case 'IssueFieldTextValue':
        out.push({ field: name, value: String(node.value ?? '') });
        break;
      default:
        break;
    }
  }
  return out;
}

/** `fetchIssueFields` — the IssueField definitions for a repo or organization. */
async function fetchIssueFields(client, owner, repo, signal) {
  const data = repo
    ? await client.graphql(ISSUE_FIELDS_REPO_QUERY, { owner, name: repo }, { signal })
    : await client.graphql(ISSUE_FIELDS_ORG_QUERY, { login: owner }, { signal });
  const nodes = repo ? data?.repository?.issueFields?.nodes : data?.organization?.issueFields?.nodes;
  const fields = [];
  for (const node of nodes ?? []) {
    const dataType = node?.dataType;
    switch (node?.__typename) {
      case 'IssueFieldSingleSelect':
        fields.push({
          id: String(node.id ?? ''),
          full_database_id: parseFullDatabaseId(node.fullDatabaseId),
          name: node.name ?? '',
          description: node.description ?? '',
          data_type: dataType ?? '',
          visibility: node.visibility ?? '',
          options: (node.options ?? []).map((option) =>
            issueFieldOption({
              id: String(option?.id ?? ''),
              name: option?.name ?? '',
              description: option?.description ?? '',
              color: option?.color ?? '',
              priority: option?.priority ?? undefined,
            }),
          ),
        });
        break;
      case 'IssueFieldText':
      case 'IssueFieldNumber':
      case 'IssueFieldDate':
        fields.push({
          id: String(node.id ?? ''),
          full_database_id: parseFullDatabaseId(node.fullDatabaseId),
          name: node.name ?? '',
          description: node.description ?? '',
          data_type: dataType ?? '',
          visibility: node.visibility ?? '',
        });
        break;
      default:
        break;
    }
  }
  return fields;
}

/** `resolveIssueRequestFieldValues` — name → REST {field_id, value} / delete ids. */
async function resolveIssueRequestFieldValues(client, owner, repo, issueFields, signal) {
  if (issueFields.length === 0) return { values: [], fieldIdsToDelete: [] };

  const data = await client.graphql(ISSUE_FIELD_WRITE_METADATA_QUERY, { owner, repo }, { signal });
  const byName = new Map();
  for (const node of data?.repository?.issueFields?.nodes ?? []) {
    const fragment = node?.[node.__typename];
    if (!fragment?.name) continue;
    byName.set(String(fragment.name).trim().toLowerCase(), { node, fragment });
  }

  const values = [];
  const fieldIdsToDelete = [];
  for (const input of issueFields) {
    const entry = byName.get(String(input.field_name).trim().toLowerCase());
    if (!entry) fail(`issue field "${input.field_name}" was not found in ${owner}/${repo}`);

    const fieldId = parseFullDatabaseId(entry.fragment.fullDatabaseId);
    if (fieldId === 0) fail(`issue field "${input.field_name}" is missing fullDatabaseId`);

    if (input.delete) {
      fieldIdsToDelete.push(fieldId);
      continue;
    }

    let resolvedValue = input.value;
    if (input.field_option_name) {
      if (String(entry.fragment.dataType ?? '').toLowerCase() !== 'single_select') {
        fail(`issue field "${input.field_name}" is "${entry.fragment.dataType}", so field_option_name cannot be used`);
      }
      const options = entry.node.IssueFieldSingleSelect?.options ?? [];
      const wanted = String(input.field_option_name).trim().toLowerCase();
      const match = options.find((option) => String(option?.name ?? '').trim().toLowerCase() === wanted);
      if (!match) {
        fail(`issue field option "${input.field_option_name}" was not found for field "${input.field_name}"`);
      }
      // The REST API expects the option name, not the option id.
      resolvedValue = match.name;
    }

    values.push({ field_id: fieldId, value: resolvedValue });
  }
  return { values, fieldIdsToDelete };
}

/** `fetchExistingIssueFieldValues` — current values, ready to be merged. */
async function fetchExistingIssueFieldValues(client, owner, repo, issueNumber, signal) {
  const data = await client.graphql(
    EXISTING_ISSUE_FIELD_VALUES_QUERY,
    { owner, repo, number: issueNumber },
    { signal },
  );
  const out = [];
  for (const node of data?.repository?.issue?.issueFieldValues?.nodes ?? []) {
    const fieldId = parseFullDatabaseId(node?.field?.fullDatabaseId);
    if (fieldId === 0) continue;
    switch (node.__typename) {
      case 'IssueFieldDateValue':
        out.push({ field_id: fieldId, value: String(node.value ?? '') });
        break;
      case 'IssueFieldNumberValue':
        out.push({ field_id: fieldId, value: node.valueNumber ?? 0 });
        break;
      case 'IssueFieldSingleSelectValue':
      case 'IssueFieldTextValue':
        out.push({ field_id: fieldId, value: String(node.value ?? '') });
        break;
      default:
        break;
    }
  }
  return out;
}

/** `mergeIssueFieldValues` — incoming wins; existing order preserved after. */
function mergeIssueFieldValues(existing, incoming) {
  const seen = new Set(incoming.map((entry) => entry.field_id));
  return [...incoming, ...existing.filter((entry) => !seen.has(entry.field_id))];
}

/** `optionalIssueWriteFields` — validate the `issue_fields` argument. */
function parseIssueWriteFields(args) {
  if (!hasArg(args, 'issue_fields')) return [];
  const raw = args.issue_fields;
  if (!Array.isArray(raw)) fail('issue_fields must be an array');

  const fields = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      fail('each issue_fields item must be an object');
    }
    const fieldName = optionalString(item, 'field_name');
    if (!fieldName) fail('field_name is required for each issue_fields item');
    const fieldOptionName = optionalString(item, 'field_option_name');
    const deleteField = item.delete === true || item.delete === 'true';
    const hasValue = Object.prototype.hasOwnProperty.call(item, 'value') && item.value !== undefined;
    if (hasValue && item.value === null) fail(`value cannot be null for field "${fieldName}"`);

    if (deleteField) {
      if (hasValue || fieldOptionName) {
        fail(`issue field "${fieldName}" cannot specify 'delete' together with 'value' or 'field_option_name'`);
      }
      fields.push({ field_name: fieldName, delete: true });
      continue;
    }
    if (hasValue && fieldOptionName) {
      fail(`issue field "${fieldName}" cannot specify both value and field_option_name`);
    }
    if (!hasValue && !fieldOptionName) {
      fail(`issue field "${fieldName}" must specify either value or field_option_name`);
    }
    fields.push({ field_name: fieldName, value: item.value, field_option_name: fieldOptionName });
  }
  return fields;
}

/** `fetchIssueIDs` — resolve the issue (and duplicate) global node ids. */
async function fetchIssueIds(client, owner, repo, issueNumber, duplicateOf, signal) {
  if (!duplicateOf) {
    const data = await client.graphql(ISSUE_ID_QUERY, { owner, repo, issueNumber }, { signal });
    return { issueId: data?.repository?.issue?.id, duplicateIssueId: undefined };
  }
  const data = await client.graphql(
    ISSUE_AND_DUPLICATE_ID_QUERY,
    { owner, repo, issueNumber, duplicateOf },
    { signal },
  );
  return {
    issueId: data?.repository?.issue?.id,
    duplicateIssueId: data?.repository?.duplicateIssue?.id,
  };
}

/** `getLabelID` — resolve a label node id, or fail with the legacy message. */
async function labelId(client, owner, repo, name, signal) {
  const data = await client.graphql(LABEL_ID_QUERY, { owner, repo, name }, { signal });
  const label = data?.repository?.label;
  if (!label?.name) fail(`label '${name}' not found in ${owner}/${repo}`);
  return label.id;
}

/** `resolveUserID`. */
async function userId(client, login, signal) {
  const data = await client.graphql(USER_ID_QUERY, { login }, { signal });
  const user = data?.user;
  if (!user?.login) fail(`user "${login}" was not found`);
  return user.id;
}

/** `resolveMilestoneID`. */
async function milestoneId(client, owner, repo, number, signal) {
  const data = await client.graphql(MILESTONE_ID_QUERY, { owner, repo, milestoneNumber: number }, { signal });
  const milestone = data?.repository?.milestone;
  if (!milestone?.number) fail(`milestone #${number} was not found in ${owner}/${repo}`);
  return milestone.id;
}

/** `resolveIssueTypeID` — REST issue-types lookup by (case-insensitive) name. */
async function issueTypeId(client, owner, repo, name, signal) {
  const types = await client.get(`/repos/${seg(owner)}/${seg(repo)}/issue-types`, { signal });
  const wanted = String(name).trim().toLowerCase();
  for (const type of Array.isArray(types) ? types : []) {
    if (String(type?.name ?? '').trim().toLowerCase() !== wanted) continue;
    if (!type?.node_id) fail(`issue type "${name}" is missing a node ID`);
    return type.node_id;
  }
  fail(`issue type "${name}" was not found in ${owner}/${repo}`);
  return undefined;
}

/* ------------------------------------------------------------------ */
/* Shared validation                                                    */
/* ------------------------------------------------------------------ */

/** `validateParentRepository`. */
function validateParentRepository(parentProvided, parentOwner, parentRepo) {
  if (!parentProvided) {
    if (parentOwner || parentRepo) {
      fail('parent_owner and parent_repo can only be used when parent_issue_number is provided');
    }
    return;
  }
  if (Boolean(parentOwner) !== Boolean(parentRepo)) {
    fail('parent_owner and parent_repo must be provided together');
  }
}

/** `parentRepository` — the parent defaults to the child's own repository. */
function parentRepository(owner, repo, parentOwner, parentRepo) {
  if (!parentOwner && !parentRepo) return [owner, repo];
  return [parentOwner, parentRepo];
}

/** `validateDuplicateState`. */
function validateDuplicateState(state, stateReason, duplicateOf) {
  if (state === 'closed' && stateReason === 'duplicate' && !duplicateOf) {
    fail("duplicate_of must be provided when state_reason is 'duplicate'");
  }
}

/** `getCloseStateReason`. */
function closeStateReason(stateReason) {
  switch (stateReason) {
    case 'not_planned':
      return 'NOT_PLANNED';
    case 'duplicate':
      return 'DUPLICATE';
    default:
      return 'COMPLETED';
  }
}

/** `unappliedIssueLabelsError` — throws when the requested labels were not applied. */
function assertLabelsApplied(requested, issue) {
  const applied = labelNames(issue?.labels);
  const lower = applied.map((label) => label.toLowerCase());
  const requestedLower = requested.map((label) => label.toLowerCase());
  const missing = requestedLower.filter((label) => !lower.includes(label));
  const unexpected = lower.filter((label) => !requestedLower.includes(label));
  if (missing.length === 0 && unexpected.length === 0) return;
  fail(
    `requested=${JSON.stringify(requested)}, applied=${JSON.stringify(applied)}, ` +
      `missing=${JSON.stringify(missing)}, unexpected=${JSON.stringify(unexpected)}, ` +
      `issue_url="${issue?.html_url ?? ''}"; the caller may lack AddLabelsToLabelable permission`,
  );
}

/* ------------------------------------------------------------------ */
/* create_issue                                                         */
/* ------------------------------------------------------------------ */

/**
 * `createIssueWithParent` — create the issue and attach it to its parent in
 * one GraphQL mutation (the only path that needs GraphQL for creation).
 */
async function createIssueWithParent(ctx, options) {
  const { owner, repo, title, body, labels, assignees, milestoneNumber, issueType, parentIssueNumber } = options;
  if (!title) fail('missing required argument: title');
  if (parentIssueNumber < 1) fail('parent_issue_number must be greater than 0');

  const [parentOwner, parentRepo] = parentRepository(owner, repo, options.parentOwner, options.parentRepo);
  const data = await ctx.client.graphql(
    CREATE_ISSUE_PARENT_METADATA_QUERY,
    { owner, repo, parentOwner, parentRepo, parentIssueNumber },
    { signal: ctx.signal },
  );
  const child = data?.childRepository;
  if (!child?.nameWithOwner) fail(`repository ${owner}/${repo} was not found`);
  const parentIssue = data?.parentRepository?.issue;
  if (!parentIssue?.number) fail(`parent issue #${parentIssueNumber} was not found in ${parentOwner}/${parentRepo}`);

  const input = { repositoryId: child.id, title, parentIssueId: parentIssue.id };
  if (body) input.body = body;
  if (labels?.length) input.labelIds = await Promise.all(labels.map((label) => labelId(ctx.client, owner, repo, label, ctx.signal)));
  if (assignees?.length) {
    input.assigneeIds = await Promise.all(assignees.map((login) => userId(ctx.client, login, ctx.signal)));
  }
  if (milestoneNumber) input.milestoneId = await milestoneId(ctx.client, owner, repo, milestoneNumber, ctx.signal);
  if (issueType) input.issueTypeId = await issueTypeId(ctx.client, owner, repo, issueType, ctx.signal);

  const result = await ctx.client.graphql(CREATE_ISSUE_MUTATION, { input }, { signal: ctx.signal });
  const created = result?.createIssue?.issue;
  if (!created?.fullDatabaseId || !created?.url) {
    fail('failed to create issue: response did not include the created issue');
  }
  return { id: String(created.fullDatabaseId), url: String(created.url) };
}

/** `create_issue` — REST create, or the GraphQL parent-attaching create. */
async function createIssue(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const title = requireString(args, 'title');
  const body = optionalString(args, 'body') ?? '';
  const parentIssueNumber = optionalInt(args, 'parent_issue_number');
  const parentOwner = optionalString(args, 'parent_owner');
  const parentRepo = optionalString(args, 'parent_repo');

  if (parentIssueNumber !== undefined) {
    return createIssueWithParent(ctx, {
      owner,
      repo,
      title,
      body,
      parentIssueNumber,
      parentOwner,
      parentRepo,
    });
  }

  const request = { title };
  if (body !== '') request.body = body;
  const issue = await ctx.client.post(`/repos/${seg(owner)}/${seg(repo)}/issues`, request, { signal: ctx.signal });
  return { id: String(issue?.id ?? ''), url: issue?.html_url ?? '' };
}

/* ------------------------------------------------------------------ */
/* issue_read                                                           */
/* ------------------------------------------------------------------ */

/** The single `nodes(ids:)` enrichment for `issue_read` `get`. */
async function fetchIssueReadEnrichment(client, nodeId, signal) {
  const enrichment = {
    field_values: [],
    parent: null,
    closed_by_pull_requests: [],
    closed_by_pull_requests_total: 0,
    sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 },
  };
  const data = await client.graphql(ISSUE_READ_ENRICHMENT_QUERY, { ids: [nodeId] }, { signal });
  for (const node of data?.nodes ?? []) {
    if (!node?.id || node.id !== nodeId) continue;
    enrichment.field_values = fieldValuesFromNodes(node.issueFieldValues?.nodes);
    if (node.parent) {
      enrichment.parent = issueRef({
        number: node.parent.number,
        title: node.parent.title,
        state: node.parent.state,
        url: node.parent.url,
        repository: node.parent.repository?.nameWithOwner,
      });
    }
    enrichment.closed_by_pull_requests = (node.closedByPullRequestsReferences?.nodes ?? []).map((pr) =>
      issueRef({
        number: pr.number,
        title: pr.title,
        state: pr.state,
        url: pr.url,
        repository: pr.repository?.nameWithOwner,
      }),
    );
    enrichment.closed_by_pull_requests_total = node.closedByPullRequestsReferences?.totalCount ?? 0;
    if (node.subIssuesSummary) {
      enrichment.sub_issues_summary = {
        total: node.subIssuesSummary.total ?? 0,
        completed: node.subIssuesSummary.completed ?? 0,
        percent_completed: node.subIssuesSummary.percentCompleted ?? 0,
      };
    }
    break;
  }
  return enrichment;
}

/** `issue_read` `get`. */
async function issueReadGet(ctx, owner, repo, issueNumber) {
  const issue = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}`, {
    signal: ctx.signal,
  });
  const minimal = minimalIssueFromRest(issue);
  // The verbose REST issue_field_values are always dropped in favour of the
  // GraphQL field_values view. The enrichment is best-effort: a failure here
  // must never fail `get`.
  if (issue?.node_id) {
    try {
      const enrichment = await fetchIssueReadEnrichment(ctx.client, issue.node_id, ctx.signal);
      minimal.field_values = enrichment.field_values;
      minimal.has_parent = enrichment.parent !== null;
      minimal.has_children = enrichment.sub_issues_summary.total > 0;
      if (enrichment.parent) minimal.parent = enrichment.parent;
      minimal.closed_by_pull_requests = {
        total_count: enrichment.closed_by_pull_requests_total,
        references: enrichment.closed_by_pull_requests,
      };
      if (enrichment.sub_issues_summary.total > 0) {
        minimal.sub_issues_summary = enrichment.sub_issues_summary;
      }
    } catch (error) {
      ctx.log(`issue_read enrichment failed for #${issueNumber}: ${error?.message ?? error}`);
    }
  }
  return { method: 'get', issue: issueDetailsOutput(minimal) };
}

/** `issue_read` `get_comments`. */
async function issueReadComments(ctx, owner, repo, issueNumber, args) {
  const { page, per_page } = paginationQuery(args, { defaultPerPage: 30 });
  const comments = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/comments`, {
    query: { page, per_page },
    signal: ctx.signal,
  });
  const items = (Array.isArray(comments) ? comments : []).map((comment) =>
    issueCommentOutput(minimalCommentFromRest(comment)),
  );
  return { method: 'get_comments', comments: items };
}

/** `issue_read` `get_sub_issues`. */
async function issueReadSubIssues(ctx, owner, repo, issueNumber, args) {
  const { page, per_page } = paginationQuery(args, { defaultPerPage: 30 });
  const subIssues = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/sub_issues`, {
    query: { page, per_page },
    signal: ctx.signal,
  });
  const items = (Array.isArray(subIssues) ? subIssues : []).map(subIssueOutput);
  return { method: 'get_sub_issues', sub_issues: items };
}

/** `issue_read` `get_parent`. */
async function issueReadParent(ctx, owner, repo, issueNumber) {
  const data = await ctx.client.graphql(
    ISSUE_PARENT_QUERY,
    { owner, repo, issueNumber },
    { signal: ctx.signal },
  );
  const parent = data?.repository?.issue?.parent;
  if (!parent) return { method: 'get_parent', parent: null };
  return {
    method: 'get_parent',
    parent: issueRef({
      number: parent.number,
      title: parent.title,
      state: parent.state,
      url: parent.url,
      repository: parent.repository?.nameWithOwner,
    }),
  };
}

/** `issue_read` `get_labels`. */
async function issueReadLabels(ctx, owner, repo, issueNumber) {
  const data = await ctx.client.graphql(
    ISSUE_LABELS_QUERY,
    { owner, repo, issueNumber },
    { signal: ctx.signal },
  );
  const connection = data?.repository?.issue?.labels;
  const labels = (connection?.nodes ?? []).map(issueLabelOutput);
  return { method: 'get_labels', labels, totalCount: connection?.totalCount ?? labels.length };
}

/** `issue_read` — dispatch on `method`. */
async function issueRead(args, ctx) {
  const method = requireEnum(
    requireString(args, 'method'),
    ['get', 'get_comments', 'get_sub_issues', 'get_parent', 'get_labels'],
    'method',
  );
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');

  switch (method) {
    case 'get':
      return issueReadGet(ctx, owner, repo, issueNumber);
    case 'get_comments':
      return issueReadComments(ctx, owner, repo, issueNumber, args);
    case 'get_sub_issues':
      return issueReadSubIssues(ctx, owner, repo, issueNumber, args);
    case 'get_parent':
      return issueReadParent(ctx, owner, repo, issueNumber);
    default:
      return issueReadLabels(ctx, owner, repo, issueNumber);
  }
}

/* ------------------------------------------------------------------ */
/* issue_write                                                          */
/* ------------------------------------------------------------------ */

/** `createIssue` — the REST create used when no parent is attached. */
async function restCreateIssue(ctx, options) {
  const { owner, repo, title, body, labels, assignees, milestoneNumber, issueType, issueFieldValues } = options;
  if (!title) fail('missing required argument: title');

  const request = { title, body };
  if (assignees.length > 0) request.assignees = assignees;
  if (labels.length > 0) request.labels = labels;
  if (milestoneNumber) request.milestone = milestoneNumber;
  if (issueType) request.type = issueType;
  if (issueFieldValues?.length) request.issue_field_values = issueFieldValues;

  const issue = await ctx.client.post(`/repos/${seg(owner)}/${seg(repo)}/issues`, request, { signal: ctx.signal });
  if (labels.length > 0) assertLabelsApplied(labels, issue);
  return { id: String(issue?.id ?? ''), url: issue?.html_url ?? '' };
}

/** `updateIssue` — PATCH, the field-value delete fallback, then the state mutation. */
async function restUpdateIssue(ctx, options) {
  const {
    owner,
    repo,
    issueNumber,
    title,
    body,
    labels,
    assignees,
    milestoneNumber,
    issueType,
    issueTypeProvided,
    issueFieldValues,
    fieldIdsToDelete,
    state,
    stateReason,
    duplicateOf,
    labelsProvided,
  } = options;

  validateDuplicateState(state, stateReason, duplicateOf);

  const request = {};
  if (title) request.title = title;
  if (body) request.body = body;
  if (labelsProvided) request.labels = labels;
  if (options.assigneesProvided) request.assignees = assignees;
  if (milestoneNumber) request.milestone = milestoneNumber;
  if (issueType) request.type = issueType;

  let fallbackDeleteFieldIds = [];
  if (issueFieldValues.length > 0 || fieldIdsToDelete.length > 0) {
    // REST PATCH uses set semantics: merge the new values over the existing
    // ones, then drop anything explicitly deleted.
    const existing = await fetchExistingIssueFieldValues(ctx.client, owner, repo, issueNumber, ctx.signal);
    let merged = mergeIssueFieldValues(existing, issueFieldValues);
    if (fieldIdsToDelete.length > 0) {
      const deleteSet = new Set(fieldIdsToDelete);
      merged = merged.filter((entry) => !deleteSet.has(entry.field_id));
    }
    if (merged.length === 0 && fieldIdsToDelete.length > 0) {
      // Only queue DELETEs for fields actually present; deleting an unset field
      // is a no-op and the endpoint would 404.
      const existingIds = new Set(existing.map((entry) => entry.field_id));
      fallbackDeleteFieldIds = fieldIdsToDelete.filter((id) => existingIds.has(id));
    } else {
      request.issue_field_values = merged;
    }
  }

  const patchBody = issueTypeProvided && !issueType ? { ...request, type: null } : request;
  const updatedIssue = await ctx.client.patch(
    `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}`,
    patchBody,
    { signal: ctx.signal },
  );

  for (const fieldId of fallbackDeleteFieldIds) {
    await ctx.client.delete(
      `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/issue-field-values/${fieldId}`,
      undefined,
      { signal: ctx.signal },
    );
  }

  if (state) {
    const { issueId, duplicateIssueId } = await fetchIssueIds(
      ctx.client,
      owner,
      repo,
      issueNumber,
      duplicateOf,
      ctx.signal,
    );
    if (state === 'open') {
      await ctx.client.graphql(REOPEN_ISSUE_MUTATION, { input: { issueId } }, { signal: ctx.signal });
    } else if (state === 'closed') {
      const input = { issueId, stateReason: closeStateReason(stateReason) };
      if (stateReason === 'duplicate') input.duplicateIssueId = duplicateIssueId;
      await ctx.client.graphql(CLOSE_ISSUE_MUTATION, { input }, { signal: ctx.signal });
    }
  }

  if (labelsProvided) assertLabelsApplied(labels, updatedIssue);
  return { id: String(updatedIssue?.id ?? ''), url: updatedIssue?.html_url ?? '' };
}

/** `issue_write` — create or update a single issue. */
async function issueWrite(args, ctx) {
  const method = requireEnum(requireString(args, 'method'), ['create', 'update'], 'method');
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');

  const title = optionalString(args, 'title') ?? '';
  const body = optionalString(args, 'body') ?? '';
  const { values: assignees, provided: assigneesProvided } = stringArrayArg(args, 'assignees');
  const { values: labels, provided: labelsProvided } = stringArrayArg(args, 'labels');
  const milestoneNumber = optionalInt(args, 'milestone') ?? 0;
  const typeProvided = hasArg(args, 'type');
  const issueType = typeProvided && args.type !== null ? String(args.type) : '';
  const state = optionalString(args, 'state') ?? '';
  const stateReason = optionalString(args, 'state_reason') ?? '';
  const duplicateOf = optionalInt(args, 'duplicate_of') ?? 0;

  if (duplicateOf && stateReason !== 'duplicate') {
    fail("duplicate_of can only be used when state_reason is 'duplicate'");
  }
  validateDuplicateState(state, stateReason, duplicateOf);

  const parentIssueNumber = optionalInt(args, 'parent_issue_number');
  const parentProvided = hasArg(args, 'parent_issue_number') && args.parent_issue_number !== null;
  if (parentProvided && parentIssueNumber < 1) fail('parent_issue_number must be greater than 0');
  if (parentProvided && method !== 'create') fail('parent_issue_number can only be used with the create method');
  const parentOwner = optionalString(args, 'parent_owner');
  const parentRepo = optionalString(args, 'parent_repo');
  validateParentRepository(parentProvided, parentOwner, parentRepo);

  const issueFields = parseIssueWriteFields(args);
  if (parentProvided && issueFields.length > 0) fail('issue_fields cannot be used with parent_issue_number');

  const { values: issueFieldValues, fieldIdsToDelete } = await resolveIssueRequestFieldValues(
    ctx.client,
    owner,
    repo,
    issueFields,
    ctx.signal,
  );

  if (method === 'create') {
    if (parentProvided) {
      return createIssueWithParent(ctx, {
        owner,
        repo,
        title,
        body,
        labels,
        assignees,
        milestoneNumber,
        issueType,
        parentIssueNumber,
        parentOwner,
        parentRepo,
      });
    }
    return restCreateIssue(ctx, {
      owner,
      repo,
      title,
      body,
      labels,
      assignees,
      milestoneNumber,
      issueType,
      issueFieldValues,
    });
  }

  const issueNumber = requireInt(args, 'issue_number');
  return restUpdateIssue(ctx, {
    owner,
    repo,
    issueNumber,
    title,
    body,
    labels,
    assignees,
    milestoneNumber,
    issueType,
    issueTypeProvided: typeProvided,
    issueFieldValues,
    fieldIdsToDelete,
    state,
    stateReason,
    duplicateOf,
    labelsProvided,
    assigneesProvided,
  });
}

/* ------------------------------------------------------------------ */
/* list_issues                                                          */
/* ------------------------------------------------------------------ */

/** Build the `list_issues` GraphQL document for the requested option mix. */
function listIssuesQuery({ hasLabels, hasSince, withFieldValues }) {
  const issueArgs = ['first: $first', 'after: $after'];
  if (hasLabels) issueArgs.push('labels: $labels');
  issueArgs.push('states: $states', 'orderBy: {field: $orderBy, direction: $direction}');
  const filterArgs = [];
  if (hasSince) filterArgs.push('since: $since');
  if (withFieldValues) filterArgs.push('issueFieldValues: $issueFieldValues');
  if (filterArgs.length > 0) issueArgs.push(`filterBy: {${filterArgs.join(', ')}}`);

  const variables = [
    '$owner: String!',
    '$repo: String!',
    '$first: Int',
    '$after: String',
    '$states: [IssueState!]',
    '$orderBy: IssueOrderField!',
    '$direction: OrderDirection!',
  ];
  if (hasLabels) variables.push('$labels: [String!]');
  if (hasSince) variables.push('$since: DateTime');
  if (withFieldValues) variables.push('$issueFieldValues: [IssueFieldValueFilter!]');

  return `query(${variables.join(', ')}) {
    repository(owner: $owner, name: $repo) {
      isPrivate
      issues(${issueArgs.join(', ')}) {
        totalCount
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
        nodes {
          number
          title
          body
          state
          databaseId
          author { login }
          createdAt
          updatedAt
          labels(first: 100) { nodes { name id description } }
          assignees(first: 100) { nodes { login } }
          comments { totalCount }
          ${withFieldValues ? issueFieldValuesSelection(FIELD_REF_NAME) : ''}
        }
      }
    }
  }`;
}

/** `fragmentWithoutFieldValuesToMinimalIssue` for a GraphQL issue node. */
function minimalIssueFromFragment(node) {
  return {
    number: node?.number ?? 0,
    title: node?.title ?? '',
    body: node?.body ?? '',
    state: node?.state ?? '',
    user: { login: node?.author?.login ?? '' },
    labels: (node?.labels?.nodes ?? []).map((label) => label.name),
    assignees: (node?.assignees?.nodes ?? []).map((assignee) => assignee.login),
    comments: node?.comments?.totalCount ?? 0,
    created_at: node?.createdAt ?? '',
    updated_at: node?.updatedAt ?? '',
    field_values: fieldValuesFromNodes(node?.issueFieldValues?.nodes),
  };
}

/** `structuredListIssuesOutput` — the `fields` subset projection. */
function listIssueOutput(issue, fields) {
  const selected = (field) => fields.length === 0 || fields.includes(field);
  const out = {};
  if (selected('number')) out.number = issue.number;
  if (selected('title')) out.title = issue.title;
  if (selected('body') && issue.body) out.body = issue.body;
  if (selected('state')) out.state = issue.state;
  if (selected('user') && issue.user) out.user = issue.user;
  if (selected('labels') && issue.labels.length > 0) out.labels = issue.labels;
  if (selected('assignees')) out.assignees = issue.assignees;
  if (selected('comments') && issue.comments) out.comments = issue.comments;
  if (selected('created_at') && issue.created_at) out.created_at = issue.created_at;
  if (selected('updated_at') && issue.updated_at) out.updated_at = issue.updated_at;
  if (selected('field_values') && issue.field_values.length > 0) out.field_values = issue.field_values;
  return out;
}

/** `isUnsupportedListIssuesIssueFieldsError` — the pre-issue-fields GHES heuristic. */
function isUnsupportedIssueFieldValuesError(error) {
  const message = String(error?.message ?? '');
  if (message.includes('IssueFieldValueFilter')) return true;
  if (!message.includes('issueFieldValues')) return false;
  return (
    message.includes("doesn't exist on type") ||
    message.includes("doesn't accept argument") ||
    (message.includes("Argument 'filterBy'") && message.includes('invalid value'))
  );
}

/** `resolveFieldFilters` — coerce `{field_name, value}` into typed filters. */
function resolveFieldFilters(rawFilters, fields) {
  const byName = new Map();
  for (const field of fields) byName.set(field.name.toLowerCase(), field);

  return rawFilters.map((raw) => {
    const field = byName.get(raw.name.toLowerCase());
    if (!field) {
      const known = fields.map((entry) => entry.name).join(', ');
      fail(`field_filters: unknown field "${raw.name}". Known fields: ${known}`);
    }
    const filter = { fieldName: field.name };
    switch (field.data_type) {
      case 'SINGLE_SELECT': {
        const match = (field.options ?? []).find((option) => option.name.toLowerCase() === raw.value.toLowerCase());
        if (!match) {
          const optionNames = (field.options ?? []).map((option) => option.name).join(', ');
          fail(`field_filters: "${raw.value}" is not a valid option for "${field.name}". Valid options: ${optionNames}`);
        }
        filter.singleSelectOptionValue = match.name;
        break;
      }
      case 'TEXT':
        filter.textValue = raw.value;
        break;
      case 'DATE': {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.value) || Number.isNaN(Date.parse(raw.value))) {
          fail(`field_filters: "${raw.value}" is not a valid date for "${field.name}" (expected YYYY-MM-DD)`);
        }
        filter.dateValue = raw.value;
        break;
      }
      case 'NUMBER': {
        const parsed = Number.parseFloat(raw.value);
        if (!Number.isFinite(parsed)) {
          fail(`field_filters: "${raw.value}" is not a valid number for "${field.name}"`);
        }
        filter.numberValue = parsed;
        break;
      }
      default:
        fail(`field_filters: field "${field.name}" has unsupported data_type "${field.data_type}"`);
    }
    return filter;
  });
}

/** `parseISOTimestamp` — RFC3339 or YYYY-MM-DD. */
function parseIsoTimestamp(value) {
  if (!value) fail('invalid ISO 8601 timestamp: (empty)');
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    fail(`invalid ISO 8601 timestamp: ${value} (supported formats: YYYY-MM-DDThh:mm:ssZ or YYYY-MM-DD)`);
  }
  return new Date(parsed).toISOString();
}

/** `list_issues` — cursor-paginated GraphQL issue listing. */
async function listIssues(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');

  const state = (optionalString(args, 'state') ?? '').toUpperCase();
  const states = state === 'OPEN' || state === 'CLOSED' ? [state] : ['OPEN', 'CLOSED'];

  const labels = stringArrayArg(args, 'labels').values;
  const orderByInput = (optionalString(args, 'orderBy') ?? '').toUpperCase();
  const orderBy = ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'].includes(orderByInput) ? orderByInput : 'CREATED_AT';
  const directionInput = (optionalString(args, 'direction') ?? '').toUpperCase();
  const direction = ['ASC', 'DESC'].includes(directionInput) ? directionInput : 'DESC';

  const since = optionalString(args, 'since');
  const hasSince = Boolean(since);
  if (hasSince) parseIsoTimestamp(since);
  const hasLabels = labels.length > 0;

  const rawFilters = [];
  for (const filter of Array.isArray(args.field_filters) ? args.field_filters : []) {
    const name = optionalString(filter, 'field_name');
    const value = optionalString(filter, 'value');
    if (!name) fail('field_filters entry: missing required argument: field_name');
    if (!value) fail(`field_filters entry "${name}": missing required argument: value`);
    rawFilters.push({ name, value });
  }

  if (hasArg(args, 'page')) {
    fail("This tool uses cursor-based pagination. Use the 'after' parameter with the 'endCursor' value from the previous response instead of 'page'.");
  }

  const perPage = toPositiveInt(args.perPage ?? args.per_page, 30);
  const first = Math.min(Math.max(perPage, 1), 100);
  const after = optionalString(args, 'after') ?? null;

  let fieldFilters = [];
  if (rawFilters.length > 0) {
    const fields = await fetchIssueFields(ctx.client, owner, repo, ctx.signal);
    fieldFilters = resolveFieldFilters(rawFilters, fields);
  }

  const variables = {
    owner,
    repo,
    first,
    after,
    states,
    orderBy,
    direction,
    issueFieldValues: fieldFilters,
  };
  if (hasLabels) variables.labels = labels;
  if (hasSince) variables.since = since;

  let fragment;
  try {
    const data = await ctx.client.graphql(
      listIssuesQuery({ hasLabels, hasSince, withFieldValues: true }),
      variables,
      { signal: ctx.signal },
    );
    fragment = data?.repository?.issues;
  } catch (error) {
    if (fieldFilters.length > 0 || !isUnsupportedIssueFieldValuesError(error)) throw error;
    // Older GHES schemas lack the optional issue_fields filter; retry without it.
    const fallbackVariables = { ...variables };
    delete fallbackVariables.issueFieldValues;
    const data = await ctx.client.graphql(
      listIssuesQuery({ hasLabels, hasSince, withFieldValues: false }),
      fallbackVariables,
      { signal: ctx.signal },
    );
    fragment = data?.repository?.issues;
  }

  const fields = stringArrayArg(args, 'fields').values;
  const issues = (fragment?.nodes ?? []).map((node) => minimalIssueFromFragment(node));
  return {
    issues: issues.map((issue) => listIssueOutput(issue, fields)),
    totalCount: fragment?.totalCount ?? 0,
    pageInfo: {
      hasNextPage: Boolean(fragment?.pageInfo?.hasNextPage),
      hasPreviousPage: Boolean(fragment?.pageInfo?.hasPreviousPage),
      ...(fragment?.pageInfo?.startCursor ? { startCursor: fragment.pageInfo.startCursor } : {}),
      ...(fragment?.pageInfo?.endCursor ? { endCursor: fragment.pageInfo.endCursor } : {}),
    },
  };
}

/* ------------------------------------------------------------------ */
/* list_issue_types / list_issue_fields                                 */
/* ------------------------------------------------------------------ */

/** `list_issue_types` — repo-scoped or org-level issue types. */
async function listIssueTypes(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = optionalString(args, 'repo');
  const types = repo
    ? await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/issue-types`, { signal: ctx.signal })
    : await ctx.client.get(`/orgs/${seg(owner)}/issue-types`, { signal: ctx.signal });
  // NOTE: upstream advertises a bare array for this tool's output schema; this
  // plugin wraps it in the standard list envelope (`{ items: [...] }`) — see
  // README.md "Deviations".
  return listResult((Array.isArray(types) ? types : []).map(issueTypeOutput));
}

/** `list_issue_fields` — repo-scoped or org-level IssueField definitions. */
async function listIssueFields(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = optionalString(args, 'repo');
  const fields = await fetchIssueFields(ctx.client, owner, repo, ctx.signal);
  const items = fields.map((field) => {
    const out = {
      id: field.id,
      name: field.name,
      data_type: field.data_type,
      visibility: field.visibility,
    };
    if (field.full_database_id) out.full_database_id = field.full_database_id;
    if (field.description) out.description = field.description;
    if (field.options) out.options = field.options;
    return out;
  });
  // NOTE: see list_issue_types — upstream's bare-array output schema is wrapped
  // in the standard list envelope to satisfy the handler contract.
  return listResult(items);
}

/* ------------------------------------------------------------------ */
/* add_issue_comment / update_issue_comment                             */
/* ------------------------------------------------------------------ */

/** `add_issue_comment` — add a comment and/or an emoji reaction. */
async function addIssueComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');

  const commentId = optionalInt(args, 'comment_id');
  const body = optionalString(args, 'body');
  const reaction = optionalString(args, 'reaction');

  if (commentId !== undefined && commentId < 1) fail('comment_id must be greater than 0');
  if (commentId !== undefined && body !== undefined) fail('comment_id cannot be combined with body');
  if (commentId !== undefined && reaction === undefined) {
    fail('comment_id can only be provided when reaction is provided');
  }
  if (body === undefined && reaction === undefined) fail('at least one of body or reaction is required');
  if (body === '') fail('body cannot be empty when provided');
  if (reaction === '') fail('reaction cannot be empty when provided');
  if (reaction !== undefined && !['+1', '-1', 'laugh', 'confused', 'heart', 'hooray', 'rocket', 'eyes'].includes(reaction)) {
    fail('reaction must be one of +1, -1, laugh, confused, heart, hooray, rocket, eyes');
  }

  let reactionOutput = null;
  if (reaction !== undefined) {
    if (commentId !== undefined) {
      const comment = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}`, {
        signal: ctx.signal,
      });
      const commentIssueNumber = Number.parseInt(String(comment?.issue_url ?? '').split('/').pop(), 10);
      if (!Number.isFinite(commentIssueNumber)) {
        fail(`failed to determine issue number for comment (issue_url: ${comment?.issue_url ?? ''})`);
      }
      if (commentIssueNumber !== issueNumber) {
        fail(`comment_id does not belong to issue_number ${issueNumber}`);
      }
      const created = await ctx.client.post(
        `/repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}/reactions`,
        { content: reaction },
        { signal: ctx.signal },
      );
      reactionOutput = { id: String(created?.id ?? '') };
    } else {
      const created = await ctx.client.post(
        `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/reactions`,
        { content: reaction },
        { signal: ctx.signal },
      );
      reactionOutput = { id: String(created?.id ?? '') };
    }
  }

  let commentOutput = null;
  if (body !== undefined) {
    const created = await ctx.client.post(
      `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/comments`,
      { body },
      { signal: ctx.signal },
    );
    commentOutput = { id: String(created?.id ?? ''), html_url: created?.html_url ?? '' };
  }

  if (body !== undefined && reaction !== undefined) {
    return { comment: commentOutput, reaction: reactionOutput };
  }
  if (reaction !== undefined) return reactionOutput;
  return commentOutput;
}

/** `update_issue_comment` — PATCH an issue/PR conversation comment body. */
async function updateIssueComment(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const commentId = requireInt(args, 'comment_id');
  const body = requireString(args, 'body');
  if (commentId < 1) fail('comment_id must be greater than 0');

  const updated = await ctx.client.patch(
    `/repos/${seg(owner)}/${seg(repo)}/issues/comments/${commentId}`,
    { body },
    { signal: ctx.signal },
  );
  return { id: String(updated?.id ?? ''), html_url: updated?.html_url ?? '' };
}

/* ------------------------------------------------------------------ */
/* sub-issue write tools                                                */
/* ------------------------------------------------------------------ */

/** `addSubIssue` — POST /issues/{n}/sub_issues. */
async function addSubIssue(ctx, owner, repo, issueNumber, subIssueId, replaceParent) {
  const subIssue = await ctx.client.post(
    `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/sub_issues`,
    { sub_issue_id: subIssueId, replace_parent: Boolean(replaceParent) },
    { signal: ctx.signal },
  );
  return { method: 'add', issue: subIssueOutput(subIssue) };
}

/** `removeSubIssue` — DELETE /issues/{n}/sub_issue. */
async function removeSubIssue(ctx, owner, repo, issueNumber, subIssueId) {
  const subIssue = await ctx.client.delete(
    `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/sub_issue`,
    { sub_issue_id: subIssueId },
    { signal: ctx.signal },
  );
  return { method: 'remove', issue: subIssueOutput(subIssue) };
}

/** `reprioritizeSubIssue` — PATCH /issues/{n}/sub_issues/priority. */
async function reprioritizeSubIssue(ctx, owner, repo, issueNumber, subIssueId, afterId, beforeId) {
  if (!afterId && !beforeId) fail('either after_id or before_id must be specified');
  if (afterId && beforeId) fail('only one of after_id or before_id should be specified, not both');

  const body = { sub_issue_id: subIssueId };
  if (afterId) body.after_id = afterId;
  if (beforeId) body.before_id = beforeId;
  const subIssue = await ctx.client.patch(
    `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/sub_issues/priority`,
    body,
    { signal: ctx.signal },
  );
  return { method: 'reprioritize', issue: subIssueOutput(subIssue) };
}

/** `sub_issue_write` — add / remove / reprioritize in one tool. */
async function subIssueWrite(args, ctx) {
  const method = requireEnum(requireString(args, 'method'), ['add', 'remove', 'reprioritize'], 'method');
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');
  const subIssueId = requireInt(args, 'sub_issue_id');
  const replaceParent = args.replace_parent === true || args.replace_parent === 'true';
  const afterId = optionalInt(args, 'after_id') ?? 0;
  const beforeId = optionalInt(args, 'before_id') ?? 0;

  switch (method) {
    case 'add':
      return addSubIssue(ctx, owner, repo, issueNumber, subIssueId, replaceParent);
    case 'remove':
      return removeSubIssue(ctx, owner, repo, issueNumber, subIssueId);
    default:
      return reprioritizeSubIssue(ctx, owner, repo, issueNumber, subIssueId, afterId, beforeId);
  }
}

/** `add_sub_issue` — the granular form of `sub_issue_write` `add`. */
async function addSubIssueTool(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');
  const subIssueId = requireInt(args, 'sub_issue_id');
  const replaceParent = args.replace_parent === true || args.replace_parent === 'true';
  return addSubIssue(ctx, owner, repo, issueNumber, subIssueId, replaceParent);
}

/** `remove_sub_issue` — the granular form of `sub_issue_write` `remove`. */
async function removeSubIssueTool(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');
  const subIssueId = requireInt(args, 'sub_issue_id');
  return removeSubIssue(ctx, owner, repo, issueNumber, subIssueId);
}

/** `reprioritize_sub_issue` — the granular form of `sub_issue_write` `reprioritize`. */
async function reprioritizeSubIssueTool(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');
  const subIssueId = requireInt(args, 'sub_issue_id');
  const afterId = optionalInt(args, 'after_id') ?? 0;
  const beforeId = optionalInt(args, 'before_id') ?? 0;
  return reprioritizeSubIssue(ctx, owner, repo, issueNumber, subIssueId, afterId, beforeId);
}

/* ------------------------------------------------------------------ */
/* issue dependencies                                                   */
/* ------------------------------------------------------------------ */

/**
 * `nextPage` — the page number of the `rel="next"` link, or 0. The upstream
 * reads `github.Response.NextPage`, which go-github derives from the same
 * `Link` header.
 */
function nextPage(linkHeader, currentPage) {
  const next = nextLink(linkHeader);
  if (!next) return 0;
  try {
    const page = new URL(next).searchParams.get('page');
    return page ? Number.parseInt(page, 10) : currentPage + 1;
  } catch {
    return currentPage + 1;
  }
}

/** `issue_dependency_read` — blocked_by / blocking, page-based. */
async function issueDependencyRead(args, ctx) {
  const method = requireEnum(requireString(args, 'method'), ['get_blocked_by', 'get_blocking'], 'method');
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');
  const { page, per_page } = paginationQuery(args, { defaultPerPage: 30 });

  const path = `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/dependencies/${
    method === 'get_blocked_by' ? 'blocked_by' : 'blocking'
  }`;
  const { json, response } = await ctx.client.request('GET', path, {
    query: { page, per_page },
    signal: ctx.signal,
  });
  const issues = (Array.isArray(json) ? json : []).map(dependencyRef);
  const followingPage = nextPage(response.headers.get('link'), page);
  return {
    issues,
    pageInfo: { hasNextPage: followingPage !== 0, nextPage: followingPage },
  };
}

/** `issue_dependency_write` — add/remove a blocked_by relationship (REST). */
async function issueDependencyWrite(args, ctx) {
  const method = requireEnum(requireString(args, 'method'), ['add', 'remove'], 'method');
  const relationshipType = requireEnum(requireString(args, 'type'), ['blocked_by', 'blocking'], 'type');
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');
  const relatedIssueNumber = requireInt(args, 'related_issue_number');
  const relatedOwner = optionalString(args, 'related_owner') ?? owner;
  const relatedRepo = optionalString(args, 'related_repo') ?? repo;

  if (owner === relatedOwner && repo === relatedRepo && issueNumber === relatedIssueNumber) {
    fail('an issue cannot block or depend on itself');
  }

  // The REST endpoints are always expressed as "the blocked issue is
  // blocked_by the blocking issue", so `blocking` swaps the roles.
  let blocked = { owner, repo, number: issueNumber };
  let blocking = { owner: relatedOwner, repo: relatedRepo, number: relatedIssueNumber };
  if (relationshipType === 'blocking') {
    [blocked, blocking] = [blocking, blocked];
  }

  // The REST API identifies the blocking issue by its global database id.
  const blockingIssue = await ctx.client.get(
    `/repos/${seg(blocking.owner)}/${seg(blocking.repo)}/issues/${blocking.number}`,
    { signal: ctx.signal },
  );
  const blockingId = blockingIssue?.id;
  if (!blockingId) fail(`issue #${blocking.number} not found in ${blocking.owner}/${blocking.repo}`);

  const base = `/repos/${seg(blocked.owner)}/${seg(blocked.repo)}/issues/${blocked.number}/dependencies/blocked_by`;
  const message = method === 'add' ? 'dependency added' : 'dependency removed';
  const blockedIssue =
    method === 'add'
      ? await ctx.client.post(base, { issue_id: blockingId }, { signal: ctx.signal })
      : await ctx.client.delete(`${base}/${blockingId}`, undefined, { signal: ctx.signal });

  const blockedRef = dependencyRef(blockedIssue);
  if (!blockedRef.repository) blockedRef.repository = `${blocked.owner}/${blocked.repo}`;
  const blockingRef = dependencyRef(blockingIssue);
  if (!blockingRef.repository) blockingRef.repository = `${blocking.owner}/${blocking.repo}`;

  return { blocked_issue: blockedRef, blocking_issue: blockingRef, message };
}

/* ------------------------------------------------------------------ */
/* find_duplicate                                                       */
/* ------------------------------------------------------------------ */

/** `find_duplicate` — the semantic-similarity REST endpoint. */
async function findDuplicate(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const issueNumber = requireInt(args, 'issue_number');

  const query = {};
  if (hasArg(args, 'confidence_threshold') && args.confidence_threshold !== null) {
    query.threshold = args.confidence_threshold;
  }
  if (hasArg(args, 'perPage') && args.perPage !== null) query.per_page = args.perPage;
  if (hasArg(args, 'page') && args.page !== null) query.page = args.page;

  const results = await ctx.client.get(
    `/repos/${seg(owner)}/${seg(repo)}/issues/${issueNumber}/semantically_similar`,
    { query, signal: ctx.signal },
  );

  const candidates = (Array.isArray(results) ? results : []).map((result) => {
    // A bare issue without ranking metadata means ranked duplicate detection is
    // not enabled for this caller; fail clearly rather than returning
    // incomplete candidates.
    if (!result?.confidence || !result?.issue) {
      fail(
        'ranked duplicate detection is unavailable: the semantic-similarity endpoint returned issues ' +
          'without ranking metadata (the server-side duplicate-ranking feature is not enabled for this caller or repository)',
      );
    }
    return {
      issue: issueRef({
        number: result.issue.number,
        title: result.issue.title,
        state: result.issue.state,
        url: result.issue.html_url,
      }),
      score: result.score ?? null,
      confidence: result.confidence,
      likely_duplicate: Boolean(result.likely_duplicate),
    };
  });
  // NOTE: upstream advertises a bare array for this tool's output schema; this
  // plugin wraps the ranked candidates in the standard list envelope
  // (`{ items: [...] }`) — see README.md "Deviations".
  return listResult(candidates);
}

/* ------------------------------------------------------------------ */
/* search_issues                                                        */
/* ------------------------------------------------------------------ */

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `hasFilter` — `type:\S+` at a word boundary. */
function hasFilter(query, filterType) {
  return new RegExp(`(^|\\s|\\W)${escapeRegExp(filterType)}:\\S+`).test(query);
}

/** `hasSpecificFilter` — `is:issue` at a word boundary. */
function hasSpecificFilter(query, filterType, filterValue) {
  return new RegExp(`(^|\\s|\\W)${escapeRegExp(filterType)}:${escapeRegExp(filterValue)}($|\\s|\\W)`).test(query);
}

/** `stripFreeTextQuotes` — strip free-text quotes, keep qualifier quotes. */
function stripFreeTextQuotes(query) {
  const sentinel = '\u0000';
  const protectedText = query.replace(/([-\w.]+:)"([^"]*)"/g, `$1${sentinel}$2${sentinel}`);
  return protectedText.replace(/"/g, '').split(sentinel).join('"');
}

/** `searchIssueOutputItem` — the `fields` subset projection of a search hit. */
function searchIssueOutputItem(issue, fieldValues, fields) {
  const selected = (field) => fields.length === 0 || fields.includes(field);
  const out = {};
  if (selected('number') && issue.number !== undefined && issue.number !== null) out.number = issue.number;
  if (selected('title') && issue.title !== undefined && issue.title !== null) out.title = issue.title;
  if (selected('body') && issue.body !== undefined && issue.body !== null) out.body = issue.body;
  if (selected('state') && issue.state !== undefined && issue.state !== null) out.state = issue.state;
  if (selected('state_reason') && issue.state_reason !== undefined && issue.state_reason !== null) {
    out.state_reason = issue.state_reason;
  }
  if (selected('draft') && issue.draft !== undefined && issue.draft !== null) out.draft = issue.draft;
  if (selected('locked') && issue.locked !== undefined && issue.locked !== null) out.locked = issue.locked;
  if (selected('html_url') && issue.html_url !== undefined && issue.html_url !== null) out.html_url = issue.html_url;
  if (selected('user') && issue.user) out.user = minimalUser(issue.user);
  if (selected('author_association') && issue.author_association != null) out.author_association = issue.author_association;
  if (selected('labels') && issue.labels && labelNames(issue.labels).length > 0) out.labels = labelNames(issue.labels);
  if (selected('assignee') && issue.assignee) out.assignee = issue.assignee.login;
  if (selected('assignees') && issue.assignees && issue.assignees.length > 0) {
    out.assignees = issue.assignees.filter(Boolean).map((a) => a.login);
  }
  if (selected('milestone') && issue.milestone) out.milestone = issue.milestone.title;
  if (selected('comments') && issue.comments !== undefined && issue.comments !== null) out.comments = issue.comments;
  if (selected('reactions') && issue.reactions) out.reactions = minimalReactions(issue.reactions);
  if (selected('created_at') && issue.created_at !== undefined && issue.created_at !== null) out.created_at = issue.created_at;
  if (selected('updated_at') && issue.updated_at !== undefined && issue.updated_at !== null) out.updated_at = issue.updated_at;
  if (selected('closed_at') && issue.closed_at !== undefined && issue.closed_at !== null) out.closed_at = issue.closed_at;
  if (selected('closed_by') && issue.closed_by) out.closed_by = issue.closed_by.login;
  if (selected('type') && issue.type) out.type = issue.type.name;
  if (selected('repository_url') && issue.repository_url !== undefined && issue.repository_url !== null) {
    out.repository_url = issue.repository_url;
  }
  if (selected('pull_request') && issue.pull_request) {
    out.pull_request = {
      url: issue.pull_request.url,
      html_url: issue.pull_request.html_url,
      diff_url: issue.pull_request.diff_url,
      patch_url: issue.pull_request.patch_url,
    };
  }
  if (selected('field_values') && fieldValues !== undefined) out.field_values = fieldValues;
  return out;
}

/** `fetchIssueFieldValuesByNodeID` — one nodes() round-trip for the search hits. */
async function fetchIssueFieldValuesByNodeId(client, issues, signal) {
  const ids = issues.filter((issue) => issue?.node_id).map((issue) => issue.node_id);
  if (ids.length === 0) return new Map();
  const data = await client.graphql(SEARCH_ISSUE_FIELD_VALUES_QUERY, { ids }, { signal });
  const byId = new Map();
  for (const node of data?.nodes ?? []) {
    if (!node?.id) continue;
    byId.set(node.id, fieldValuesFromNodes(node.issueFieldValues?.nodes));
  }
  return byId;
}

/** `search_issues` — REST /search/issues, scoped to `is:issue`. */
async function searchIssues(args, ctx) {
  const input = requireString(args, 'query');
  const owner = optionalString(args, 'owner');
  const repo = optionalString(args, 'repo');

  // Semantic search is the upstream default on github.com; GHES falls back to
  // lexical search because the semantic index is not available there.
  // NOTE: the plugin cannot ask the host for its type, so the (documented)
  // github.com hosts select semantic and every other host selects lexical.
  const semantic = ctx.client.host === 'github.com' || ctx.client.host === 'api.github.com';

  let query = input;
  if (!hasSpecificFilter(query, 'is', 'issue')) query = `is:issue ${query}`;
  if (owner && repo && !hasFilter(query, 'repo')) query = `repo:${owner}/${repo} ${query}`;

  const page = toPositiveInt(args.page, 1);
  const perPage = Math.min(Math.max(toPositiveInt(args.perPage ?? args.per_page, 30), 1), 100);

  const searchQuery = {
    q: query,
    sort: optionalString(args, 'sort'),
    order: optionalString(args, 'order'),
    advanced_search: query.includes('field.') ? true : undefined,
  };
  if (semantic) {
    searchQuery.q = stripFreeTextQuotes(query);
    searchQuery.search_type = 'semantic';
  }

  const result = await ctx.client.search('/search/issues', {
    query: searchQuery,
    perPage,
    maxItems: page * perPage,
    signal: ctx.signal,
  });

  const items = result.items ?? [];
  let fieldValuesById = new Map();
  if (items.length > 0) {
    try {
      fieldValuesById = await fetchIssueFieldValuesByNodeId(ctx.client, items, ctx.signal);
    } catch (error) {
      // Older GHES schemas can lack this optional enrichment; keep the REST
      // results rather than failing the whole search.
      ctx.log(`search_issues field-value enrichment failed: ${error?.message ?? error}`);
    }
  }

  const fields = stringArrayArg(args, 'fields').values;
  return {
    total_count: result.total_count,
    incomplete_results: result.incomplete_results,
    items: items.map((issue) =>
      searchIssueOutputItem(issue, issue?.node_id ? fieldValuesById.get(issue.node_id) : undefined, fields),
    ),
  };
}

export default {
  create_issue: createIssue,
  issue_read: issueRead,
  issue_write: issueWrite,
  list_issues: listIssues,
  list_issue_types: listIssueTypes,
  list_issue_fields: listIssueFields,
  add_issue_comment: addIssueComment,
  update_issue_comment: updateIssueComment,
  sub_issue_write: subIssueWrite,
  add_sub_issue: addSubIssueTool,
  remove_sub_issue: removeSubIssueTool,
  reprioritize_sub_issue: reprioritizeSubIssueTool,
  issue_dependency_read: issueDependencyRead,
  issue_dependency_write: issueDependencyWrite,
  find_duplicate: findDuplicate,
  search_issues: searchIssues,
};

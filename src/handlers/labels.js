/**
 * labels.js — 3 tool handlers.
 *
 *   - get_label
 *   - label_write
 *   - list_label
 *
 * Ported from pkg/github/labels.go (getLabelLegacy, labelWriteLegacy,
 * listLabelsLegacy) and the typed governance wrappers in
 * pkg/github/typed_governance_outputs.go, which decode the legacy JSON text
 * result into `MinimalLabel` / `ListLabelsOutput` / `LabelWriteOutput`.
 *
 * All three tools talk GraphQL: the legacy Go handlers use a githubv4 client
 * for `repository.label`, `repository.labels` and the create/update/deleteLabel
 * mutations.
 */

import { fail, optionalString, requireEnum, requireString } from '../util.js';

/** `repository.label(name:)` — the fields the legacy handler selects. */
const GET_LABEL_QUERY = `
  query($owner: String!, $repo: String!, $name: String!) {
    repository(owner: $owner, name: $repo) {
      label(name: $name) {
        id
        name
        color
        description
      }
    }
  }`;

/**
 * `repository.labels` ordered by issue count descending, mirroring the
 * `labelOrderFieldIssueCount` constant the upstream defines locally because
 * `ISSUE_COUNT` is not part of the published githubv4 enum.
 */
const LIST_LABELS_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      labels(first: 100, orderBy: {field: ISSUE_COUNT, direction: DESC}) {
        totalCount
        nodes {
          id
          name
          color
          description
        }
      }
    }
  }`;

/** `repository.id`, used as the `repositoryId` for `createLabel`. */
const REPOSITORY_ID_QUERY = `
  query($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      id
    }
  }`;

/** `repository.label(name:) { id name }`, used to resolve a label node id. */
const LABEL_ID_QUERY = `
  query($owner: String!, $repo: String!, $name: String!) {
    repository(owner: $owner, name: $repo) {
      label(name: $name) {
        id
        name
      }
    }
  }`;

const CREATE_LABEL_MUTATION = `
  mutation($input: CreateLabelInput!) {
    createLabel(input: $input) {
      label {
        id
        name
      }
    }
  }`;

const UPDATE_LABEL_MUTATION = `
  mutation($input: UpdateLabelInput!) {
    updateLabel(input: $input) {
      label {
        id
        name
      }
    }
  }`;

const DELETE_LABEL_MUTATION = `
  mutation($input: DeleteLabelInput!) {
    deleteLabel(input: $input) {
      clientMutationId
    }
  }`;

/** The `MinimalLabel` shape the typed governance wrapper decodes. */
function minimalLabel(label) {
  return {
    name: label?.name ?? '',
    color: label?.color ?? '',
    description: label?.description ?? '',
  };
}

/** Resolve the GraphQL global repository id (used by `label_write` create). */
async function repositoryId(client, owner, repo, signal) {
  const data = await client.graphql(REPOSITORY_ID_QUERY, { owner, repo }, { signal });
  const id = data?.repository?.id;
  if (!id) fail(`repository not found: ${owner}/${repo}`);
  return id;
}

/** Resolve a label node id by name, failing with the legacy error string. */
async function labelId(client, owner, repo, name, signal) {
  const data = await client.graphql(LABEL_ID_QUERY, { owner, repo, name }, { signal });
  const label = data?.repository?.label;
  if (!label?.name) fail(`label '${name}' not found in ${owner}/${repo}`);
  return label.id;
}

/** `get_label` — GraphQL `repository.label(name:)`. */
async function getLabel(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const name = requireString(args, 'name');

  const data = await ctx.client.graphql(GET_LABEL_QUERY, { owner, repo, name }, { signal: ctx.signal });
  const label = data?.repository?.label;
  if (!label?.name) fail(`label '${name}' not found in ${owner}/${repo}`);
  return minimalLabel(label);
}

/** `list_label` — GraphQL `repository.labels(orderBy: ISSUE_COUNT DESC)`. */
async function listLabel(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');

  const data = await ctx.client.graphql(LIST_LABELS_QUERY, { owner, repo }, { signal: ctx.signal });
  const connection = data?.repository?.labels;
  const labels = (connection?.nodes ?? []).map(minimalLabel);
  return { labels, totalCount: connection?.totalCount ?? labels.length };
}

/** `label_write` — GraphQL create/update/deleteLabel. */
async function labelWrite(args, ctx) {
  const method = requireEnum(requireString(args, 'method'), ['create', 'update', 'delete'], 'method');
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const name = requireString(args, 'name');
  const newName = optionalString(args, 'new_name');
  const color = optionalString(args, 'color');
  const description = optionalString(args, 'description');

  switch (method) {
    case 'create': {
      if (!color) fail('color is required for create');
      const repoId = await repositoryId(ctx.client, owner, repo, ctx.signal);
      const input = { repositoryId: repoId, name, color };
      if (description) input.description = description;
      const data = await ctx.client.graphql(CREATE_LABEL_MUTATION, { input }, { signal: ctx.signal });
      const created = data?.createLabel?.label;
      if (!created?.name) fail(`failed to create label '${name}'`);
      return { method, message: `label '${created.name}' created successfully` };
    }
    case 'update': {
      if (!newName && !color && !description) {
        fail('at least one of new_name, color, or description must be provided for update');
      }
      const id = await labelId(ctx.client, owner, repo, name, ctx.signal);
      const input = { id };
      if (newName) input.name = newName;
      if (color) input.color = color;
      if (description) input.description = description;
      const data = await ctx.client.graphql(UPDATE_LABEL_MUTATION, { input }, { signal: ctx.signal });
      const updated = data?.updateLabel?.label;
      if (!updated?.name) fail(`failed to update label '${name}'`);
      return { method, message: `label '${updated.name}' updated successfully` };
    }
    default: {
      const id = await labelId(ctx.client, owner, repo, name, ctx.signal);
      await ctx.client.graphql(DELETE_LABEL_MUTATION, { input: { id } }, { signal: ctx.signal });
      return { method, message: `label '${name}' deleted successfully` };
    }
  }
}

export default {
  get_label: getLabel,
  label_write: labelWrite,
  list_label: listLabel,
};

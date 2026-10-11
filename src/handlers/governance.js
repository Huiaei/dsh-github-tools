/**
 * governance.js — 7 tool handlers (rulesets, custom properties, projects v2).
 *
 *   - create_repository_ruleset
 *   - repository_ruleset_read
 *   - custom_properties_read
 *   - custom_properties_write
 *   - projects_get
 *   - projects_list
 *   - projects_write
 *
 * Ported from github-mcp-server:
 *   pkg/github/rulesets.go
 *   pkg/github/custom_properties.go
 *   pkg/github/projects.go
 *   pkg/github/projects_batch.go
 *   pkg/github/projects_batch_mutation.go
 *   pkg/github/projects_resolver.go
 *   pkg/github/projects_types.go
 *   pkg/github/typed_governance_outputs.go
 *   pkg/github/minimal_types.go
 *   pkg/github/params.go
 *   pkg/errors/error.go                 (StructuredResolutionError)
 *   pkg/sanitize/sanitize.go            (content sanitization)
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
import { GitHubApiError } from '../client.js';

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** Go's `%q` for the strings we interpolate into error messages. */
function quote(value) {
  return JSON.stringify(String(value));
}

/** Upstream `RequiredInt` / `RequiredBigInt`; the plugin spells the failure this way. */
function requireInt(args, key) {
  const value = toPositiveInt(args?.[key], undefined);
  if (value === undefined) fail(`missing required argument: ${key}`);
  return value;
}

/** Optional array-of-integers parameter (`OptionalBigIntArrayParam`). */
function optionalIntArray(args, key) {
  const raw = args?.[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${key} must be an array of numbers`);
  return raw.map((entry) => {
    const value = toPositiveInt(entry, undefined);
    if (value === undefined) fail(`${key} must be an array of numbers`);
    return value;
  });
}

/** Optional array-of-strings parameter (`OptionalStringArrayParam`). */
function optionalStringArray(args, key) {
  const raw = args?.[key];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(`${key} must be an array of strings`);
  return raw.map((entry) => String(entry));
}

function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Port of `sanitize.Content` (invisible-character filtering). */
const INVISIBLE_CHARACTER =
  /[\u00AD\u061C\u180E\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0001}\u{E0020}-\u{E007F}]/gu;

function sanitizeContent(value) {
  if (typeof value !== 'string' || value === '') return value ?? '';
  return value.replace(INVISIBLE_CHARACTER, '');
}

/** Drop JSON `omitempty` zero values, matching the typed output structs. */
function omitEmpty(object) {
  const out = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (value === undefined || value === null || value === '' || value === 0 || value === false) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/**
 * `StructuredResolutionError` (pkg/errors/error.go). `fail` throws its JSON body,
 * which is exactly what the upstream tool result carries as plain text.
 */
function failStructured(kind, name, hint, candidates) {
  fail(JSON.stringify(defined({ error: kind, name, hint, candidates })));
}

/* ------------------------------------------------------------------ *
 * create_repository_ruleset
 * ------------------------------------------------------------------ */

/**
 * The parameter fields go-github's `RepositoryRulesetRules` structs retain.
 * `null` is a leaf; `{}` is a rule with no parameters. `applySchema` filters a
 * request through this tree and `droppedKeyPath` reports what fell out, which is
 * how the upstream round-trip rejects unrecognized keys.
 */
const PATTERN_PARAMETERS = { name: null, negate: null, operator: null, pattern: null };

const RULESET_RULE_SCHEMA = {
  creation: {},
  update: { update_allows_fetch_and_merge: null },
  deletion: {},
  required_linear_history: {},
  merge_queue: {
    merge_method: null,
    max_entries_to_build: null,
    max_entries_to_merge: null,
    min_entries_to_merge: null,
    min_entries_to_merge_wait_minutes: null,
  },
  required_deployments: { required_deployment_environments: null },
  required_signatures: {},
  pull_request: {
    dismiss_stale_reviews_on_push: null,
    require_code_owner_review: null,
    require_last_push_approval: null,
    required_approving_review_count: null,
    required_review_thread_resolution: null,
    allowed_merge_methods: null,
  },
  required_status_checks: {
    strict_required_status_checks_policy: null,
    do_not_enforce_on_create: null,
    required_status_checks: { context: null, integration_id: null },
  },
  non_fast_forward: {},
  commit_message_pattern: PATTERN_PARAMETERS,
  commit_author_email_pattern: PATTERN_PARAMETERS,
  committer_email_pattern: PATTERN_PARAMETERS,
  branch_name_pattern: PATTERN_PARAMETERS,
  tag_name_pattern: PATTERN_PARAMETERS,
  workflows: { workflows: { path: null, ref: null, repository_id: null, sha: null } },
  code_scanning: {
    code_scanning_tools: { tool: null, alerts_threshold: null, security_alerts_threshold: null },
  },
  copilot_code_review: { review_on_push: null, review_draft_pull_requests: null },
  file_extension_restriction: { restricted_file_extensions: null },
  file_path_restriction: { restricted_file_paths: null },
  max_file_path_length: { max_file_path_length: null },
  max_file_size: { max_file_size: null },
};

const PROPERTY_CONDITION_SCHEMA = {
  include: { name: null, property_values: null, source: null },
  exclude: { name: null, property_values: null, source: null },
};

const RULESET_CONDITIONS_SCHEMA = {
  ref_name: { include: null, exclude: null, protected: null },
  repository_id: { repository_ids: null, organization_ids: null },
  repository_name: { include: null, exclude: null, protected: null },
  repository_property: PROPERTY_CONDITION_SCHEMA,
  organization_id: { repository_ids: null, organization_ids: null },
  organization_name: { include: null, exclude: null, protected: null },
  organization_property: PROPERTY_CONDITION_SCHEMA,
};

const BYPASS_ACTOR_KEYS = ['actor_id', 'actor_type', 'bypass_mode'];
const BYPASS_MODES = ['always', 'pull_request', 'exempt'];

/** Keep only the keys `schema` recognizes, recursively. */
function applySchema(schema, value) {
  if (Array.isArray(value)) return value.map((item) => applySchema(schema, item));
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) continue;
    out[key] = applySchema(schema[key], value[key]);
  }
  return out;
}

function isZeroJsonValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') return value === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

/** Port of `droppedKeyPath` (rulesets.go:958). */
function droppedKeyPath(requested, applied) {
  for (const key of Object.keys(requested ?? {})) {
    const requestedValue = requested[key];
    const hasApplied = Object.prototype.hasOwnProperty.call(applied ?? {}, key);
    if (!hasApplied) {
      if (isZeroJsonValue(requestedValue)) continue;
      return key;
    }
    const nested = droppedValuePath(requestedValue, applied[key]);
    if (nested !== '') return key + nested;
  }
  return '';
}

function droppedValuePath(requested, applied) {
  if (Array.isArray(requested)) {
    if (!Array.isArray(applied)) return '';
    for (let i = 0; i < requested.length; i += 1) {
      if (i >= applied.length) {
        if (isZeroJsonValue(requested[i])) continue;
        return `[${i}]`;
      }
      const nested = droppedValuePath(requested[i], applied[i]);
      if (nested !== '') return `[${i}]${nested}`;
    }
    return '';
  }
  if (requested !== null && typeof requested === 'object') {
    if (applied === null || typeof applied !== 'object' || Array.isArray(applied)) return '';
    const nested = droppedKeyPath(requested, applied);
    return nested === '' ? '' : `.${nested}`;
  }
  return '';
}

/**
 * Port of `buildRepositoryRulesetFromArgs` (rulesets.go:823), including the
 * go-github JSON round-trip that rejects fields the structs would discard.
 */
function buildRulesetPayload(args) {
  const name = requireString(args, 'name');
  const enforcement = requireString(args, 'enforcement');
  const target = optionalString(args, 'target') ?? '';

  const rawRules = args?.rules;
  if (!Array.isArray(rawRules)) fail('rules parameter must be an array of rule objects');

  const requestedRuleTypes = [];
  const requestedRuleParameters = new Map();
  const seenRuleTypes = new Set();
  for (let i = 0; i < rawRules.length; i += 1) {
    const rule = rawRules[i];
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
      fail("each rule must be an object with a 'type' field");
    }
    for (const key of Object.keys(rule)) {
      if (key !== 'type' && key !== 'parameters') {
        fail(`rules[${i}]: unsupported or unrecognized key: ${quote(key)}`);
      }
    }
    const ruleType = rule.type;
    if (typeof ruleType !== 'string' || ruleType === '') {
      fail("each rule must have a non-empty string 'type' field");
    }
    if (seenRuleTypes.has(ruleType)) {
      fail(`duplicate rule type: ${quote(ruleType)} (a ruleset may only have one rule of each type)`);
    }
    seenRuleTypes.add(ruleType);
    requestedRuleTypes.push(ruleType);
    if (rule.parameters !== undefined && rule.parameters !== null) {
      if (typeof rule.parameters !== 'object' || Array.isArray(rule.parameters)) {
        fail(`rule ${quote(ruleType)}: parameters must be an object`);
      }
      requestedRuleParameters.set(ruleType, rule.parameters);
    }
  }

  const payload = { name, enforcement, rules: rawRules };
  if (target !== '') payload.target = target;

  const rawConditions = args?.conditions;
  if (rawConditions !== undefined && rawConditions !== null) {
    if (typeof rawConditions !== 'object' || Array.isArray(rawConditions)) {
      fail('conditions parameter must be an object');
    }
    payload.conditions = rawConditions;
  }

  const rawBypassActors = args?.bypass_actors;
  if (rawBypassActors !== undefined && rawBypassActors !== null) {
    if (!Array.isArray(rawBypassActors)) fail('bypass_actors parameter must be an array of objects');
    rawBypassActors.forEach((actor, i) => {
      if (actor === null || typeof actor !== 'object' || Array.isArray(actor)) {
        fail(`bypass_actors[${i}] must be an object`);
      }
      for (const key of Object.keys(actor)) {
        if (!BYPASS_ACTOR_KEYS.includes(key)) {
          fail(`bypass_actors[${i}]: unsupported or unrecognized key: ${quote(key)}`);
        }
      }
      if (typeof actor.bypass_mode !== 'string') {
        fail(`bypass_actors[${i}].bypass_mode is required and must be a string`);
      }
      if (!BYPASS_MODES.includes(actor.bypass_mode)) {
        fail(`bypass_actors[${i}].bypass_mode must be one of "always", "pull_request", or "exempt"`);
      }
    });
    payload.bypass_actors = rawBypassActors;
  }

  for (const ruleType of requestedRuleTypes) {
    const schema = RULESET_RULE_SCHEMA[ruleType];
    if (schema === undefined) fail(`unsupported or unrecognized rule type: ${quote(ruleType)}`);
    const requested = requestedRuleParameters.get(ruleType);
    if (requested !== undefined) {
      const dropped = droppedKeyPath(requested, applySchema(schema, requested));
      if (dropped !== '') {
        fail(`rule ${quote(ruleType)}: unsupported or unrecognized parameter: ${quote(dropped)}`);
      }
    }
  }

  if (payload.conditions !== undefined) {
    const dropped = droppedKeyPath(payload.conditions, applySchema(RULESET_CONDITIONS_SCHEMA, payload.conditions));
    if (dropped !== '') fail(`conditions: unsupported or unrecognized key: ${quote(dropped)}`);
  }

  return payload;
}

/** Project a REST ruleset into `RulesetOutput`. */
function rulesetOutput(raw) {
  const source = raw ?? {};
  return defined({
    id: source.id,
    name: source.name ?? '',
    target: source.target,
    source_type: source.source_type,
    source: source.source ?? '',
    enforcement: source.enforcement ?? '',
    bypass_actors: source.bypass_actors,
    current_user_can_bypass: source.current_user_can_bypass,
    conditions: source.conditions,
    rules: source.rules,
    created_at: source.created_at,
    updated_at: source.updated_at,
  });
}

/** Create a ruleset at the repository, organization, or enterprise level. */
async function createRepositoryRuleset(args, ctx) {
  const level = requireString(args, 'level');
  const payload = buildRulesetPayload(args);

  const post = async (path, errorMessage) => {
    try {
      return await ctx.client.post(path, payload, { signal: ctx.signal });
    } catch (error) {
      fail(`${errorMessage}: ${describe(error)}`);
    }
    return undefined;
  };

  switch (level) {
    case 'repository': {
      const owner = requireString(args, 'owner');
      const repo = requireString(args, 'repo');
      const created = await post(`/repos/${seg(owner)}/${seg(repo)}/rulesets`, 'failed to create repository ruleset');
      return rulesetOutput(created);
    }
    case 'organization': {
      const org = requireString(args, 'org');
      const created = await post(`/orgs/${seg(org)}/rulesets`, 'failed to create organization repository ruleset');
      return rulesetOutput(created);
    }
    case 'enterprise': {
      const enterprise = requireString(args, 'enterprise');
      const created = await post(
        `/enterprises/${seg(enterprise)}/rulesets`,
        'failed to create enterprise repository ruleset',
      );
      return rulesetOutput(created);
    }
    default:
      fail(`unknown level: ${quote(level)} (expected 'repository', 'organization', or 'enterprise')`);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * repository_ruleset_read
 * ------------------------------------------------------------------ */

/** `governanceBranchRuleNames` (typed_governance_outputs.go:388). */
const BRANCH_RULE_GROUPS = [
  ['Creation', 'creation'],
  ['Update', 'update'],
  ['Deletion', 'deletion'],
  ['RequiredLinearHistory', 'required_linear_history'],
  ['MergeQueue', 'merge_queue'],
  ['RequiredDeployments', 'required_deployments'],
  ['RequiredSignatures', 'required_signatures'],
  ['PullRequest', 'pull_request'],
  ['RequiredStatusChecks', 'required_status_checks'],
  ['NonFastForward', 'non_fast_forward'],
  ['CommitMessagePattern', 'commit_message_pattern'],
  ['CommitAuthorEmailPattern', 'commit_author_email_pattern'],
  ['CommitterEmailPattern', 'committer_email_pattern'],
  ['BranchNamePattern', 'branch_name_pattern'],
  ['TagNamePattern', 'tag_name_pattern'],
  ['Workflows', 'workflows'],
  ['CodeScanning', 'code_scanning'],
  ['CopilotCodeReview', 'copilot_code_review'],
  ['FileExtensionRestriction', 'file_extension_restriction'],
  ['FilePathRestriction', 'file_path_restriction'],
  ['MaxFilePathLength', 'max_file_path_length'],
  ['MaxFileSize', 'max_file_size'],
];

/** Flatten the go-github `BranchRules` text into `GovernanceRuleOutput[]`. */
function flattenBranchRules(raw) {
  const groups = raw ?? {};
  const rules = [];
  for (const [field, kind] of BRANCH_RULE_GROUPS) {
    for (const rule of asArray(groups[field])) {
      rules.push(
        defined({
          type: kind,
          parameters: rule?.parameters,
          ruleset_id: rule?.ruleset_id,
          ruleset_source: rule?.ruleset_source,
          ruleset_source_type: rule?.ruleset_source_type,
        }),
      );
    }
  }
  return rules;
}

/** Project a rule suite into `RuleSuiteOutput`. */
function ruleSuiteOutput(raw) {
  const suite = raw ?? {};
  const out = defined({
    id: suite.id ?? 0,
    actor_id: suite.actor_id,
    actor_name: suite.actor_name,
    before_sha: suite.before_sha,
    after_sha: suite.after_sha,
    ref: suite.ref,
    pushed_at: suite.pushed_at,
    result: suite.result ?? '',
    evaluation_result: suite.evaluation_result,
    repository_id: suite.repository_id,
    repository_name: suite.repository_name,
  });
  if (Array.isArray(suite.rule_evaluations)) {
    out.rule_evaluations = suite.rule_evaluations.map((evaluation) =>
      defined({
        rule_source:
          evaluation?.rule_source === undefined || evaluation?.rule_source === null
            ? undefined
            : defined({
                type: evaluation.rule_source.type,
                id: evaluation.rule_source.id,
                name: evaluation.rule_source.name,
              }),
        enforcement: evaluation?.enforcement,
        result: evaluation?.result,
        rule_type: evaluation?.rule_type,
        details: evaluation?.details,
      }),
    );
  }
  return out;
}

/** Query parameters shared by the rule-suite list endpoints. */
function ruleSuiteQuery(args, { includeRepositoryName }) {
  const query = {};
  const ref = optionalString(args, 'ref');
  if (ref !== undefined) query.ref = ref;
  const repositoryName = optionalString(args, 'repository_name');
  if (includeRepositoryName && repositoryName !== undefined) query.repository_name = repositoryName;
  const timePeriod = optionalString(args, 'time_period');
  if (timePeriod !== undefined) query.time_period = timePeriod;
  const actorName = optionalString(args, 'actor_name');
  if (actorName !== undefined) query.actor_name = actorName;
  const ruleSuiteResult = optionalString(args, 'rule_suite_result');
  if (ruleSuiteResult !== undefined) query.rule_suite_result = ruleSuiteResult;
  const evaluateStatus = optionalString(args, 'evaluate_status');
  if (evaluateStatus !== undefined) query.evaluate_status = evaluateStatus;
  return query;
}

async function rulesetReadRepository(args, ctx, method, level) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const base = `/repos/${seg(owner)}/${seg(repo)}`;

  switch (method) {
    case 'get': {
      const rulesetID = requireInt(args, 'ruleset_id');
      // GetRuleset always sends includes_parents, so preserve GitHub's true default.
      const includesParents =
        args?.includes_parents === undefined ? true : optionalBoolean(args, 'includes_parents', true);
      const ruleset = await ctx.client.get(`${base}/rulesets/${rulesetID}`, {
        query: { includes_parents: includesParents },
        signal: ctx.signal,
      });
      return { method, level, ruleset: rulesetOutput(ruleset) };
    }
    case 'list': {
      const query = paginationQuery(args);
      if (args?.includes_parents !== undefined) {
        query.includes_parents = optionalBoolean(args, 'includes_parents', true);
      }
      const rulesets = await ctx.client.get(`${base}/rulesets`, { query, signal: ctx.signal });
      return { method, level, rulesets: asArray(rulesets).map(rulesetOutput) };
    }
    case 'get_rules_for_branch': {
      const branch = requireString(args, 'branch');
      const query = paginationQuery(args);
      const groups = await ctx.client.get(`${base}/rules/branches/${seg(branch)}`, {
        query,
        signal: ctx.signal,
      });
      return { method, level, rules: flattenBranchRules(groups) };
    }
    case 'list_rule_suites': {
      const query = { ...ruleSuiteQuery(args, { includeRepositoryName: false }), ...paginationQuery(args) };
      const suites = await ctx.client.get(`${base}/rulesets/rule-suites`, { query, signal: ctx.signal });
      return { method, level, rule_suites: asArray(suites).map(ruleSuiteOutput) };
    }
    case 'get_rule_suite': {
      const ruleSuiteID = requireInt(args, 'rule_suite_id');
      const suite = await ctx.client.get(`${base}/rulesets/rule-suites/${ruleSuiteID}`, {
        signal: ctx.signal,
      });
      return { method, level, rule_suite: ruleSuiteOutput(suite) };
    }
    default:
      fail(`unknown method: ${quote(method)}`);
  }
  return undefined;
}

async function rulesetReadOrganization(args, ctx, method, level) {
  const org = requireString(args, 'org');
  const base = `/orgs/${seg(org)}`;

  switch (method) {
    case 'get': {
      const rulesetID = requireInt(args, 'ruleset_id');
      const ruleset = await ctx.client.get(`${base}/rulesets/${rulesetID}`, { signal: ctx.signal });
      return { method, level, ruleset: rulesetOutput(ruleset) };
    }
    case 'list': {
      const rulesets = await ctx.client.get(`${base}/rulesets`, {
        query: paginationQuery(args),
        signal: ctx.signal,
      });
      return { method, level, rulesets: asArray(rulesets).map(rulesetOutput) };
    }
    case 'list_rule_suites': {
      const query = { ...ruleSuiteQuery(args, { includeRepositoryName: true }), ...paginationQuery(args) };
      const suites = await ctx.client.get(`${base}/rulesets/rule-suites`, { query, signal: ctx.signal });
      return { method, level, rule_suites: asArray(suites).map(ruleSuiteOutput) };
    }
    case 'get_rule_suite': {
      const ruleSuiteID = requireInt(args, 'rule_suite_id');
      const suite = await ctx.client.get(`${base}/rulesets/rule-suites/${ruleSuiteID}`, { signal: ctx.signal });
      return { method, level, rule_suite: ruleSuiteOutput(suite) };
    }
    default:
      fail(
        `method ${quote(method)} is not supported for level "organization"; supported methods: get, list, list_rule_suites, get_rule_suite`,
      );
  }
  return undefined;
}

async function rulesetReadEnterprise(args, ctx, method, level) {
  const enterprise = requireString(args, 'enterprise');
  const base = `/enterprises/${seg(enterprise)}`;

  switch (method) {
    case 'get': {
      const rulesetID = requireInt(args, 'ruleset_id');
      const ruleset = await ctx.client.get(`${base}/rulesets/${rulesetID}`, { signal: ctx.signal });
      return { method, level, ruleset: rulesetOutput(ruleset) };
    }
    case 'list': {
      const response = await ctx.client.get(`${base}/rulesets`, {
        query: paginationQuery(args),
        signal: ctx.signal,
      });
      const out = { method, level, rulesets: asArray(response?.rulesets).map(rulesetOutput) };
      if (response?.total_count !== undefined) out.total_count = response.total_count;
      return out;
    }
    default:
      fail(`method ${quote(method)} is not supported for level "enterprise"; supported methods: get, list`);
  }
  return undefined;
}

/** Read repository rulesets at the repository, organization, or enterprise level. */
async function repositoryRulesetRead(args, ctx) {
  const level = requireString(args, 'level');
  const method = requireString(args, 'method').toLowerCase();

  switch (level) {
    case 'repository':
      return rulesetReadRepository(args, ctx, method, level);
    case 'organization':
      return rulesetReadOrganization(args, ctx, method, level);
    case 'enterprise':
      return rulesetReadEnterprise(args, ctx, method, level);
    default:
      fail(`unknown level: ${quote(level)} (expected 'repository', 'organization', or 'enterprise')`);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * custom_properties_read / custom_properties_write
 * ------------------------------------------------------------------ */

/** Project a repository custom property value into `CustomPropertyValueOutput`. */
function customPropertyValueOutput(value) {
  return defined({
    property_name: value?.property_name ?? '',
    value: value?.value === undefined ? null : value.value,
  });
}

/** Port of `parseCustomProperties` (custom_properties.go:472). */
function parseCustomProperties(args, validateItem) {
  const raw = args?.properties;
  if (raw === undefined || raw === null) fail('properties parameter is required');
  if (!Array.isArray(raw)) fail('properties parameter must be an array');
  return raw.map((item, i) => {
    const problem = validateItem(item);
    if (problem !== null) fail(`properties[${i}] is invalid: ${problem}`);
    return item;
  });
}

function validateCustomPropertyValue(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'must be an object';
  for (const key of Object.keys(item)) {
    if (key !== 'property_name' && key !== 'value') return `unsupported key ${quote(key)}`;
  }
  if (typeof item.property_name !== 'string') return 'property_name is required';
  if (!Object.prototype.hasOwnProperty.call(item, 'value')) return 'value is required';
  const { value } = item;
  if (value === null || typeof value === 'string') return null;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return null;
  return 'value must be a string, an array of strings, or null';
}

const DEFINITION_FIELDS = [
  'value_type',
  'required',
  'default_value',
  'description',
  'allowed_values',
  'values_editable_by',
  'require_explicit_values',
];

const VALUE_TYPES = ['string', 'single_select', 'multi_select', 'true_false', 'url'];
const VALUES_EDITABLE_BY = ['org_actors', 'org_and_repo_actors'];

function validateCustomPropertyDefinition(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return 'must be an object';
  for (const key of Object.keys(item)) {
    if (key !== 'property_name' && !DEFINITION_FIELDS.includes(key)) return `unsupported key ${quote(key)}`;
  }
  if (typeof item.property_name !== 'string') return 'property_name is required';
  if (item.value_type !== undefined && !VALUE_TYPES.includes(item.value_type)) {
    return `value_type must be one of ${VALUE_TYPES.join(', ')}`;
  }
  if (item.required !== undefined && typeof item.required !== 'boolean') return 'required must be a boolean';
  if (item.description !== undefined && item.description !== null && typeof item.description !== 'string') {
    return 'description must be a string or null';
  }
  if (item.values_editable_by !== undefined && item.values_editable_by !== null) {
    if (!VALUES_EDITABLE_BY.includes(item.values_editable_by)) {
      return `values_editable_by must be one of ${VALUES_EDITABLE_BY.join(', ')}`;
    }
  }
  if (item.require_explicit_values !== undefined && typeof item.require_explicit_values !== 'boolean') {
    return 'require_explicit_values must be a boolean';
  }
  if (item.allowed_values !== undefined && item.allowed_values !== null) {
    if (!Array.isArray(item.allowed_values) || !item.allowed_values.every((entry) => typeof entry === 'string')) {
      return 'allowed_values must be an array of strings or null';
    }
  }
  return null;
}

function validateUniqueCustomPropertyNames(properties) {
  const seen = new Set();
  properties.forEach((property, i) => {
    const name = property.property_name;
    if (seen.has(name)) fail(`properties[${i}].property_name duplicates ${quote(name)}`);
    seen.add(name);
  });
}

/** Port of `mergeCustomPropertyDefinitions` (custom_properties.go:434). */
function mergeCustomPropertyDefinitions(current, requested, sourceType) {
  const currentByName = new Map();
  for (const property of current) {
    const name = property?.property_name;
    if (typeof name === 'string' && name !== '') currentByName.set(name, property);
  }

  const merged = [];
  requested.forEach((update, i) => {
    const name = update.property_name;
    const existing = currentByName.get(name);
    if (existing === undefined) {
      if (!Object.prototype.hasOwnProperty.call(update, 'value_type')) {
        fail(`properties[${i}].value_type is required for new property ${quote(name)}`);
      }
      merged.push(update);
      return;
    }
    const existingSource = typeof existing.source_type === 'string' ? existing.source_type : '';
    if (existingSource !== '' && existingSource !== sourceType) {
      fail(
        `property ${quote(name)} is inherited from ${existingSource} and cannot be updated at the ${sourceType} level`,
      );
    }
    const property = { property_name: name };
    for (const field of DEFINITION_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(existing, field)) property[field] = existing[field];
      if (Object.prototype.hasOwnProperty.call(update, field)) property[field] = update[field];
    }
    merged.push(property);
  });
  return merged;
}

/** Port of `customPropertiesWriteDefinitions` (custom_properties.go:375). */
async function writeCustomPropertyDefinitions(ctx, apiURL, sourceType, requested) {
  validateUniqueCustomPropertyNames(requested);

  let current;
  try {
    current = await ctx.client.get(apiURL, { signal: ctx.signal });
  } catch (error) {
    fail(`failed to get ${sourceType} custom properties before updating: ${describe(error)}`);
  }

  const merged = mergeCustomPropertyDefinitions(asArray(current), requested, sourceType);

  try {
    const updated = await ctx.client.patch(apiURL, { properties: merged }, { signal: ctx.signal });
    return asArray(updated);
  } catch (error) {
    fail(`failed to update ${sourceType} custom properties: ${describe(error)}`);
  }
  return [];
}

/** Read custom property values (repository) or definitions (org/enterprise). */
async function customPropertiesRead(args, ctx) {
  const level = requireString(args, 'level');

  switch (level) {
    case 'repository': {
      const owner = requireString(args, 'owner');
      const repo = requireString(args, 'repo');
      let values;
      try {
        values = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/properties/values`, {
          signal: ctx.signal,
        });
      } catch (error) {
        fail(`failed to get repository custom property values: ${describe(error)}`);
      }
      return { method: 'read', level, values: asArray(values).map(customPropertyValueOutput) };
    }
    case 'organization': {
      const org = requireString(args, 'org');
      let definitions;
      try {
        definitions = await ctx.client.get(`/orgs/${seg(org)}/properties/schema`, { signal: ctx.signal });
      } catch (error) {
        fail(`failed to get organization custom properties: ${describe(error)}`);
      }
      return { method: 'read', level, definitions: asArray(definitions) };
    }
    case 'enterprise': {
      const enterprise = requireString(args, 'enterprise');
      let definitions;
      try {
        definitions = await ctx.client.get(`/enterprises/${seg(enterprise)}/properties/schema`, {
          signal: ctx.signal,
        });
      } catch (error) {
        fail(`failed to get enterprise custom properties: ${describe(error)}`);
      }
      return { method: 'read', level, definitions: asArray(definitions) };
    }
    default:
      fail(`unknown level: ${quote(level)} (expected 'repository', 'organization', or 'enterprise')`);
  }
  return undefined;
}

/** Create or update custom property values (repository) or definitions (org/enterprise). */
async function customPropertiesWrite(args, ctx) {
  const level = requireString(args, 'level');

  switch (level) {
    case 'repository': {
      const owner = requireString(args, 'owner');
      const repo = requireString(args, 'repo');
      const values = parseCustomProperties(args, validateCustomPropertyValue);
      try {
        // go-github's CreateOrUpdateCustomProperties wraps the array as {"properties": [...]}.
        await ctx.client.patch(
          `/repos/${seg(owner)}/${seg(repo)}/properties/values`,
          { properties: values },
          { signal: ctx.signal },
        );
      } catch (error) {
        fail(`failed to update repository custom property values: ${describe(error)}`);
      }
      return {
        method: 'write',
        level,
        message: 'Repository custom property values updated successfully',
      };
    }
    case 'organization': {
      const org = requireString(args, 'org');
      const properties = parseCustomProperties(args, validateCustomPropertyDefinition);
      const definitions = await writeCustomPropertyDefinitions(
        ctx,
        `/orgs/${seg(org)}/properties/schema`,
        'organization',
        properties,
      );
      return { method: 'write', level, definitions };
    }
    case 'enterprise': {
      const enterprise = requireString(args, 'enterprise');
      const properties = parseCustomProperties(args, validateCustomPropertyDefinition);
      const definitions = await writeCustomPropertyDefinitions(
        ctx,
        `/enterprises/${seg(enterprise)}/properties/schema`,
        'enterprise',
        properties,
      );
      return { method: 'write', level, definitions };
    }
    default:
      fail(`unknown level: ${quote(level)} (expected 'repository', 'organization', or 'enterprise')`);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * projects v2 — shared helpers
 * ------------------------------------------------------------------ */

const MAX_PROJECTS_PER_PAGE = 50;
const MAX_PROJECT_ITEMS_PER_BATCH = 50;
const BATCH_WIRE_CHUNK_SIZE = 20;
const PROJECT_RESOLVER_PAGE_SIZE = 100;

const PROJECT_UPDATE_FAILED = 'failed to update a project item';
const PROJECT_ADD_FAILED = 'failed to add a project item';
const PROJECT_DELETE_FAILED = 'failed to delete a project item';
const PROJECT_LIST_FAILED = 'failed to list project items';
const PROJECT_STATUS_UPDATE_LIST_FAILED = 'failed to list project status updates';
const PROJECT_STATUS_UPDATE_GET_FAILED = 'failed to get project status update';
const PROJECT_STATUS_UPDATE_CREATE_FAILED = 'failed to create project status update';
const PROJECT_VIEW_LIST_FAILED = 'failed to list project views';
const PROJECT_VIEW_GET_FAILED = 'failed to get project view';
const PROJECT_VIEW_CREATE_FAILED = 'failed to create project view';
const PROJECT_VIEW_UPDATE_FAILED = 'failed to update project view';
const PROJECT_VIEW_DELETE_FAILED = 'failed to delete project view';
const PROJECT_RESOLVE_ID_FAILED = 'failed to resolve project ID';

const PROJECT_ITEM_LIST_METHODS = [
  'list_project_fields',
  'list_project_items',
  'list_project_status_updates',
  'list_project_views',
];

const PROJECT_STATUSES = ['INACTIVE', 'ON_TRACK', 'AT_RISK', 'OFF_TRACK', 'COMPLETE'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value) {
  return typeof value === 'string' && DATE_ONLY.test(value);
}

/** `optionalProjectsPerPage` (projects.go:2522): default and cap at 50. */
function optionalProjectsPerPage(args) {
  const raw = args?.perPage !== undefined ? args.perPage : args?.per_page;
  const value = toPositiveInt(raw, MAX_PROJECTS_PER_PAGE);
  return Math.min(value, MAX_PROJECTS_PER_PAGE);
}

/** `extractPaginationOptionsFromArgs` (projects.go:2531). */
function projectPagination(args) {
  const query = { per_page: optionalProjectsPerPage(args) };
  const after = optionalString(args, 'after');
  if (after !== undefined) query.after = after;
  const before = optionalString(args, 'before');
  if (before !== undefined) query.before = before;
  return query;
}

/** Parse `Link` cursors the way go-github fills `Response.After`/`Before`. */
function pageInfoFromResponse(response) {
  const link = response?.headers?.get?.('link') ?? '';
  let next = null;
  let prev = null;
  for (const part of String(link).split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part.trim());
    if (match === null) continue;
    if (match[2] === 'next') next = match[1];
    if (match[2] === 'prev') prev = match[1];
  }
  const cursor = (url, key) => {
    if (url === null) return '';
    try {
      return new URL(url).searchParams.get(key) ?? '';
    } catch {
      return '';
    }
  };
  return defined({
    hasNextPage: next !== null,
    hasPreviousPage: prev !== null,
    nextCursor: cursor(next, 'after'),
    prevCursor: cursor(prev, 'before'),
  });
}

function graphqlPageInfo(connection) {
  const info = connection?.pageInfo ?? {};
  return {
    hasNextPage: Boolean(info.hasNextPage),
    hasPreviousPage: Boolean(info.hasPreviousPage),
    nextCursor: info.endCursor == null ? '' : String(info.endCursor),
    prevCursor: info.startCursor == null ? '' : String(info.startCursor),
  };
}

function minimalUser(user) {
  if (!user) return undefined;
  return defined({
    login: user.login ?? '',
    id: user.id,
    profile_url: user.html_url,
    avatar_url: user.avatar_url,
  });
}

/** `convertToMinimalProject` (minimal_types.go:1208). */
function minimalProject(project) {
  if (!project) return undefined;
  const out = {
    id: project.id ?? 0,
    node_id: project.node_id ?? '',
    title: project.title ?? '',
    description: project.description ?? '',
    public: project.public ?? false,
    closed_at: project.closed_at ?? null,
    created_at: project.created_at ?? null,
    updated_at: project.updated_at ?? null,
    deleted_at: project.deleted_at ?? null,
    number: project.number ?? 0,
    short_description: project.short_description ?? '',
  };
  const owner = minimalUser(project.owner);
  if (owner !== undefined) out.owner = owner;
  const creator = minimalUser(project.creator);
  if (creator !== undefined) out.creator = creator;
  const deletedBy = minimalUser(project.deleted_by);
  if (deletedBy !== undefined) out.deleted_by = deletedBy;
  return out;
}

/** `minimalProjectFieldValue` (minimal_types.go:1381) for raw REST/GraphQL values. */
function projectFieldValue(value) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(projectFieldValue);
  if (typeof value !== 'object') return value;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    if (typeof value.login === 'string') return value.login;
    if (typeof value.name === 'string') return value.name;
    if (typeof value.title === 'string') return value.title;
    if (typeof value.full_name === 'string') return value.full_name;
  }
  if (value.color !== undefined && value.name !== undefined) {
    return omitEmpty({ id: value.id, name: value.name, color: value.color });
  }
  if (value.start_date !== undefined && value.duration !== undefined) {
    return omitEmpty({
      id: value.id,
      title: value.title,
      start_date: value.start_date,
      duration: value.duration,
    });
  }
  return value;
}

function projectFieldValueOutput(field) {
  return omitEmpty({
    id: field?.id,
    name: field?.name,
    data_type: field?.data_type,
    value: projectFieldValue(field?.value),
  });
}

function projectTextOutput(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return { html: value, raw: value };
  return omitEmpty({ html: value.html, raw: value.raw });
}

/** `ProjectFieldOutput` (projects_types.go:226). */
function projectFieldOutput(field) {
  if (!field) return undefined;
  const out = omitEmpty({
    id: field.id,
    node_id: field.node_id,
    name: field.name,
    data_type: field.data_type,
    created_at: field.created_at,
    updated_at: field.updated_at,
  });
  if (Array.isArray(field.options) && field.options.length > 0) {
    out.options = field.options.map((option) =>
      omitEmpty({
        id: option?.id,
        color: option?.color,
        description: projectTextOutput(option?.description),
        name: projectTextOutput(option?.name),
      }),
    );
  }
  if (field.configuration) {
    const configuration = field.configuration;
    const shaped = omitEmpty({ duration: configuration.duration, start_day: configuration.start_day });
    if (Array.isArray(configuration.iterations) && configuration.iterations.length > 0) {
      shaped.iterations = configuration.iterations.map((iteration) =>
        omitEmpty({
          id: iteration?.id,
          title: projectTextOutput(iteration?.title),
          start_date: iteration?.start_date,
          duration: iteration?.duration,
        }),
      );
    }
    out.configuration = shaped;
  }
  return out;
}

/** `convertToMinimalProjectItemContent` (minimal_types.go:1254). */
function minimalProjectItemContent(content) {
  if (!content) return undefined;
  const repository =
    typeof content.repository === 'string' ? content.repository : content.repository?.full_name;
  return omitEmpty({
    id: content.id,
    node_id: content.node_id,
    number: content.number,
    title: sanitizeContent(content.title ?? ''),
    state: content.state,
    state_reason: content.state_reason,
    html_url: content.html_url,
    repository,
    author: content.user?.login ?? content.creator?.login,
    assignees: asArray(content.assignees).map((assignee) => assignee?.login ?? assignee).filter(Boolean),
    labels: asArray(content.labels).map((label) => label?.name ?? label).filter(Boolean),
    milestone: content.milestone?.title,
    comments: content.comments,
    draft: content.draft,
    merged: content.merged,
    created_at: content.created_at,
    updated_at: content.updated_at,
    closed_at: content.closed_at,
    merged_at: content.merged_at,
  });
}

/** `convertToMinimalProjectItem` (minimal_types.go:1231). */
function minimalProjectItem(item) {
  if (!item) return { id: 0 };
  const out = { id: item.id ?? 0 };
  if (item.node_id) out.node_id = item.node_id;
  if (item.content_type) out.content_type = item.content_type;
  const content = minimalProjectItemContent(item.content);
  if (content !== undefined && Object.keys(content).length > 0) out.content = content;
  if (Array.isArray(item.fields) && item.fields.length > 0) {
    out.fields = item.fields.map(projectFieldValueOutput);
  }
  if (item.archived_at) out.archived_at = item.archived_at;
  if (item.created_at) out.created_at = item.created_at;
  if (item.updated_at) out.updated_at = item.updated_at;
  const creator = item.creator?.login ?? (typeof item.creator === 'string' ? item.creator : undefined);
  if (creator) out.creator = creator;
  return out;
}

/** `convertToMinimalStatusUpdate` (projects.go:261). */
function statusUpdateOutput(node) {
  if (!node) return { id: '' };
  const creator = node.creator?.login ? { login: String(node.creator.login) } : undefined;
  return omitEmpty({
    id: node.id == null ? '' : String(node.id),
    body: sanitizeContent(node.body ?? ''),
    status: node.status == null ? '' : String(node.status),
    created_at: node.createdAt == null ? '' : String(node.createdAt),
    start_date: node.startDate == null ? '' : String(node.startDate),
    target_date: node.targetDate == null ? '' : String(node.targetDate),
    creator,
  });
}

/** `projectViewLayoutName` (projects.go:1911). */
function projectViewLayoutName(layout) {
  switch (layout) {
    case 'TABLE_LAYOUT':
      return 'table';
    case 'BOARD_LAYOUT':
      return 'board';
    case 'ROADMAP_LAYOUT':
      return 'roadmap';
    default:
      return String(layout ?? '')
        .replace(/_LAYOUT$/, '')
        .toLowerCase();
  }
}

/** `parseProjectViewLayout` (projects.go:1924). */
function parseProjectViewLayout(layout) {
  switch (String(layout ?? '').trim().toLowerCase()) {
    case 'table':
      return 'TABLE_LAYOUT';
    case 'board':
      return 'BOARD_LAYOUT';
    case 'roadmap':
      return 'ROADMAP_LAYOUT';
    default:
      fail(`invalid layout ${quote(layout)}: must be "table", "board", or "roadmap"`);
  }
  return undefined;
}

/** `convertToMinimalProjectView` (projects.go:1887). */
function projectViewOutput(node) {
  if (!node) return undefined;
  const visibleFields = [];
  for (const field of asArray(node.configuration?.visibleFields?.nodes)) {
    const databaseID =
      field?.databaseId ?? field?.ProjectV2Field?.databaseId ?? field?.ProjectV2SingleSelectField?.databaseId;
    visibleFields.push(Number(databaseID ?? 0));
  }
  return {
    id: node.id == null ? '' : String(node.id),
    number: Number(node.number ?? 0),
    name: String(node.name ?? ''),
    layout: projectViewLayoutName(node.layout),
    filter: node.filter == null ? '' : String(node.filter),
    visible_fields: visibleFields,
  };
}

const VIEW_NODE_SELECTION = `id
        number
        name
        layout
        filter
        configuration {
          visibleFields(first: 100) {
            nodes {
              ... on ProjectV2Field { databaseId }
              ... on ProjectV2IterationField { databaseId }
              ... on ProjectV2MultiSelectField { databaseId }
              ... on ProjectV2SingleSelectField { databaseId }
            }
          }
        }`;

/* ---------- REST plumbing ---------- */

function projectPath(ownerType, owner, projectNumber) {
  const scope = ownerType === 'org' ? 'orgs' : 'users';
  return `/${scope}/${seg(owner)}/projectsV2/${projectNumber}`;
}

async function restGet(ctx, path, query) {
  return ctx.client.request('GET', path, { query, signal: ctx.signal });
}

/** `detectOwnerType` (projects.go:2869). */
async function detectOwnerType(ctx, owner, projectNumber) {
  try {
    const user = await ctx.client.get(`/users/${seg(owner)}`, { signal: ctx.signal });
    if (user?.type === 'User') return 'user';
    if (user?.type === 'Organization') return 'org';
  } catch {
    // Fall through to the project probes.
  }
  try {
    await ctx.client.get(`/users/${seg(owner)}/projectsV2/${projectNumber}`, { signal: ctx.signal });
    return 'user';
  } catch {
    // Try the organization endpoint next.
  }
  try {
    await ctx.client.get(`/orgs/${seg(owner)}/projectsV2/${projectNumber}`, { signal: ctx.signal });
    return 'org';
  } catch {
    // Neither owner type worked.
  }
  fail(
    `could not determine owner type for ${owner} with project ${projectNumber}: owner is neither a user nor an org with this project`,
  );
  return undefined;
}

/* ---------- GraphQL resolvers ---------- */

/** `resolveProjectNodeID` (projects.go:1599). */
async function resolveProjectNodeID(ctx, owner, ownerType, projectNumber) {
  const scope = ownerType === 'org' ? 'organization' : 'user';
  const query = `query($owner: String!, $projectNumber: Int!) {
  ${scope}(login: $owner) { projectV2(number: $projectNumber) { id } }
}`;
  let data;
  try {
    data = await ctx.client.graphql(query, { owner, projectNumber }, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_RESOLVE_ID_FAILED}: ${describe(error)}`);
  }
  return data?.[scope]?.projectV2?.id ?? null;
}

/** `listAllProjectFields` (projects_resolver.go:88). */
async function listAllProjectFields(ctx, owner, ownerType, projectNumber) {
  const scope = ownerType === 'org' ? 'organization' : 'user';
  const query = `query($owner: String!, $projectNumber: Int!, $first: Int!, $after: String) {
  ${scope}(login: $owner) {
    projectV2(number: $projectNumber) {
      fields(first: $first, after: $after) {
        nodes {
          ... on ProjectV2Field { id databaseId name dataType }
          ... on ProjectV2IterationField { id databaseId name dataType }
          ... on ProjectV2MultiSelectField { id databaseId name dataType }
          ... on ProjectV2SingleSelectField { id databaseId name dataType options { id name } }
        }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
}`;

  const all = [];
  let after = null;
  for (;;) {
    let data;
    try {
      data = await ctx.client.graphql(
        query,
        { owner, projectNumber, first: PROJECT_RESOLVER_PAGE_SIZE, after },
        { signal: ctx.signal },
      );
    } catch (error) {
      fail(`failed to list project fields: ${describe(error)}`);
    }
    const connection = data?.[scope]?.projectV2?.fields;
    for (const node of asArray(connection?.nodes)) {
      all.push({
        id: String(node?.databaseId ?? ''),
        nodeId: node?.id == null ? '' : String(node.id),
        name: String(node?.name ?? ''),
        dataType: String(node?.dataType ?? ''),
        options: asArray(node?.options).map((option) => ({
          id: String(option?.id ?? ''),
          name: String(option?.name ?? ''),
        })),
        isIssueField: false,
        issueFieldID: '',
      });
    }
    if (connection?.pageInfo?.hasNextPage !== true) break;
    after = connection.pageInfo.endCursor ?? null;
  }
  return all;
}

/** `resolveFieldsByName` (projects_resolver.go:161). */
function resolveFieldsByName(all, owner, projectNumber, names, idParameter) {
  const byName = new Map();
  for (const field of all) {
    const key = field.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), field]);
  }

  const resolved = [];
  for (const name of names) {
    const matches = byName.get(name.toLowerCase()) ?? [];
    if (matches.length === 0) {
      failStructured(
        'field_not_found',
        name,
        `no project field named ${quote(name)} on project ${owner}#${projectNumber}`,
        all.map((field) => ({ name: field.name, data_type: field.dataType })),
      );
    }
    if (matches.length > 1) {
      failStructured(
        'field_ambiguous',
        name,
        `multiple fields share this name; pass numeric IDs via '${idParameter}' to disambiguate`,
        matches.map((field) => ({ id: field.id, data_type: field.dataType })),
      );
    }
    resolved.push(matches[0]);
  }
  return resolved;
}

/** `resolveFieldNamesToIDs` (projects_resolver.go:585). */
async function resolveFieldNamesToIDs(ctx, owner, ownerType, projectNumber, names, idParameter) {
  if (names.length === 0) return [];
  const all = await listAllProjectFields(ctx, owner, ownerType, projectNumber);
  const resolved = resolveFieldsByName(all, owner, projectNumber, names, idParameter);
  return resolved.map((field, i) => {
    const id = Number(field.id);
    if (!Number.isFinite(id)) {
      fail(`resolved field ${quote(names[i])} has non-numeric ID ${quote(field.id)}; pass it via '${idParameter}' instead`);
    }
    return id;
  });
}

/** `resolveProjectFieldByName` (projects_resolver.go:218). */
async function resolveProjectFieldByName(ctx, owner, ownerType, projectNumber, fieldName, expectedDataType) {
  if (fieldName === '') fail('field name must not be empty');
  const all = await listAllProjectFields(ctx, owner, ownerType, projectNumber);
  const matches = all.filter((field) => field.name.toLowerCase() === fieldName.toLowerCase());

  if (matches.length === 0) {
    failStructured(
      'field_not_found',
      fieldName,
      `no project field named ${quote(fieldName)} on project ${owner}#${projectNumber}; see candidates for available names`,
      all.map((field) => ({ name: field.name, data_type: field.dataType })),
    );
  }
  if (matches.length > 1) {
    failStructured(
      'field_ambiguous',
      fieldName,
      'multiple fields share this name; pass updated_field.id to disambiguate',
      matches.map((field) => ({ id: field.id, data_type: field.dataType })),
    );
  }
  const field = matches[0];
  if (expectedDataType !== '' && field.dataType !== expectedDataType) {
    failStructured(
      'wrong_field_type',
      fieldName,
      `field ${quote(fieldName)} has data type ${quote(field.dataType)} but ${quote(expectedDataType)} was expected`,
      [{ id: field.id, data_type: field.dataType }],
    );
  }
  return field;
}

/** `resolveSingleSelectOptionByName` (projects_resolver.go:442). */
function resolveSingleSelectOptionByName(field, optionName) {
  if (!field) fail('field must not be nil');
  if (field.dataType !== 'SINGLE_SELECT') {
    failStructured(
      'wrong_field_type',
      field.name,
      `cannot resolve option name on non-SINGLE_SELECT field ${quote(field.name)} (data type ${quote(field.dataType)})`,
      undefined,
    );
  }
  const matches = field.options.filter((option) => option.name.toLowerCase() === optionName.toLowerCase());
  if (matches.length === 0) {
    failStructured(
      'option_not_found',
      optionName,
      `no option named ${quote(optionName)} on field ${quote(field.name)}; see candidates for available options`,
      field.options.map((option) => ({ name: option.name })),
    );
  }
  if (matches.length > 1) {
    failStructured(
      'option_ambiguous',
      optionName,
      `multiple options on field ${quote(field.name)} share the name ${quote(optionName)}`,
      matches.map((option) => ({ id: option.id })),
    );
  }
  return matches[0].id;
}

const ISSUE_FIELD_SCHEMA_ERRORS = [
  "Field 'isIssueField' doesn't exist on type 'ProjectV2Field'",
  "Field 'issueField' doesn't exist on type 'ProjectV2Field'",
  "Field 'isIssueField' doesn't exist on type 'ProjectV2SingleSelectField'",
  "Field 'issueField' doesn't exist on type 'ProjectV2SingleSelectField'",
  'No such type IssueFieldText, so it cannot be a fragment condition',
  'No such type IssueFieldNumber, so it cannot be a fragment condition',
  'No such type IssueFieldDate, so it cannot be a fragment condition',
  'No such type IssueFieldSingleSelect, so it cannot be a fragment condition',
];

/** `resolveIssueFieldForUpdate` (projects_resolver.go:316). */
async function resolveIssueFieldForUpdate(ctx, owner, ownerType, projectNumber, resolved) {
  const field = { ...resolved };
  const scope = ownerType === 'org' ? 'organization' : 'user';
  const query = `query($owner: String!, $projectNumber: Int!, $first: Int!, $after: String) {
  ${scope}(login: $owner) {
    projectV2(number: $projectNumber) {
      fields(first: $first, after: $after) {
        nodes {
          __typename
          ... on ProjectV2Field {
            databaseId
            isIssueField
            issueField {
              ... on IssueFieldText { id }
              ... on IssueFieldNumber { id }
              ... on IssueFieldDate { id }
              ... on IssueFieldSingleSelect { id options { id name } }
            }
          }
          ... on ProjectV2SingleSelectField {
            databaseId
            isIssueField
            issueField {
              ... on IssueFieldText { id }
              ... on IssueFieldNumber { id }
              ... on IssueFieldDate { id }
              ... on IssueFieldSingleSelect { id options { id name } }
            }
          }
        }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
}`;

  let after = null;
  for (;;) {
    let data;
    try {
      data = await ctx.client.graphql(
        query,
        { owner, projectNumber, first: PROJECT_RESOLVER_PAGE_SIZE, after },
        { signal: ctx.signal },
      );
    } catch (error) {
      if (ISSUE_FIELD_SCHEMA_ERRORS.includes(describe(error))) return field;
      fail(`failed to query project Issue Field metadata: ${describe(error)}`);
    }
    const connection = data?.[scope]?.projectV2?.fields;
    for (const node of asArray(connection?.nodes)) {
      if (String(node?.databaseId ?? '') !== field.id) continue;
      if (node?.isIssueField === true) {
        field.isIssueField = true;
        const metadata = node.issueField ?? {};
        field.issueFieldID = metadata.id == null ? '' : String(metadata.id);
        if (field.dataType === 'SINGLE_SELECT') {
          field.options = asArray(metadata.options).map((option) => ({
            id: String(option?.id ?? ''),
            name: String(option?.name ?? ''),
          }));
        }
      }
      return field;
    }
    if (connection?.pageInfo?.hasNextPage !== true) break;
    after = connection.pageInfo.endCursor ?? null;
  }
  failStructured('missing_field_metadata', field.name, `resolved field ${quote(field.name)} is missing update metadata`, undefined);
  return field;
}

/** `resolveProjectItemByIssueNumberWithProjectID` (projects_resolver.go:505). */
async function resolveProjectItemByIssueNumber(ctx, projectID, issueOwner, issueRepo, issueNumber) {
  const query = `query($issueOwner: String!, $issueRepo: String!, $issueNumber: Int!, $after: String) {
  repository(owner: $issueOwner, name: $issueRepo) {
    issue(number: $issueNumber) {
      projectItems(first: 50, after: $after, includeArchived: true) {
        nodes { id fullDatabaseId project { id } }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
}`;

  let after = null;
  for (;;) {
    let data;
    try {
      data = await ctx.client.graphql(
        query,
        { issueOwner, issueRepo, issueNumber, after },
        { signal: ctx.signal },
      );
    } catch (error) {
      fail(`failed to resolve project item for ${issueOwner}/${issueRepo}#${issueNumber}: ${describe(error)}`);
    }
    const connection = data?.repository?.issue?.projectItems;
    for (const item of asArray(connection?.nodes)) {
      if (String(item?.project?.id ?? '') !== String(projectID ?? '')) continue;
      const fullDatabaseID = item?.fullDatabaseId == null ? '' : String(item.fullDatabaseId);
      const itemID = Number(fullDatabaseID);
      if (!Number.isFinite(itemID)) {
        fail(`project item ID ${quote(fullDatabaseID)} is not an integer`);
      }
      return { nodeID: item?.id == null ? '' : String(item.id), itemID };
    }
    if (connection?.pageInfo?.hasNextPage !== true) break;
    after = connection.pageInfo.endCursor ?? null;
  }
  failStructured(
    'item_not_in_project',
    `${issueOwner}/${issueRepo}#${issueNumber}`,
    'the issue exists but is not an item on the named project; add it first via add_project_item',
    undefined,
  );
  return undefined;
}

/* ---------- projects_get ---------- */

async function getProjectStatusUpdate(ctx, statusUpdateID) {
  const query = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2StatusUpdate {
      id
      body
      status
      createdAt
      startDate
      targetDate
      creator { login }
      project { public }
    }
  }
}`;
  let data;
  try {
    data = await ctx.client.graphql(query, { id: statusUpdateID }, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_STATUS_UPDATE_GET_FAILED}: ${describe(error)}`);
  }
  const node = data?.node;
  if (node?.id == null || node.id === '') {
    fail(`${PROJECT_STATUS_UPDATE_GET_FAILED}: node is not a ProjectV2StatusUpdate or was not found`);
  }
  return statusUpdateOutput(node);
}

async function getProjectView(ctx, viewID) {
  const query = `query($id: ID!) {
  node(id: $id) {
    ... on ProjectV2View {
      ${VIEW_NODE_SELECTION}
      project { public }
    }
  }
}`;
  let data;
  try {
    data = await ctx.client.graphql(query, { id: viewID }, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_VIEW_GET_FAILED}: ${describe(error)}`);
  }
  const node = data?.node;
  if (node?.id == null || node.id === '') {
    fail(`${PROJECT_VIEW_GET_FAILED}: node is not a ProjectV2View or was not found`);
  }
  return projectViewOutput(node);
}

/** Get details about specific GitHub Projects resources. */
async function projectsGet(args, ctx) {
  const method = requireString(args, 'method');

  if (method === 'get_project_status_update') {
    const statusUpdateID = requireString(args, 'status_update_id');
    return { method, status_update: await getProjectStatusUpdate(ctx, statusUpdateID) };
  }
  if (method === 'get_project_view') {
    const viewID = requireString(args, 'view_id');
    return { method, view: await getProjectView(ctx, viewID) };
  }

  const owner = requireString(args, 'owner');
  const ownerTypeRaw = optionalString(args, 'owner_type') ?? '';
  const projectNumber = requireInt(args, 'project_number');
  const ownerType = ownerTypeRaw === '' ? await detectOwnerType(ctx, owner, projectNumber) : ownerTypeRaw;
  const base = projectPath(ownerType, owner, projectNumber);

  switch (method) {
    case 'get_project': {
      let project;
      try {
        project = await ctx.client.get(base, { signal: ctx.signal });
      } catch (error) {
        fail(`failed to get project: ${describe(error)}`);
      }
      return { method, project: minimalProject(project) };
    }
    case 'get_project_field': {
      const fieldID = requireInt(args, 'field_id');
      let field;
      try {
        field = await ctx.client.get(`${base}/fields/${fieldID}`, { signal: ctx.signal });
      } catch (error) {
        fail(`failed to get project field: ${describe(error)}`);
      }
      return { method, field: projectFieldOutput(field) };
    }
    case 'get_project_item': {
      const itemID = requireInt(args, 'item_id');
      let fields = optionalIntArray(args, 'fields');
      const fieldNames = optionalStringArray(args, 'field_names');
      if (fields.length > 0 && fieldNames.length > 0) {
        fail("provide either 'fields' or 'field_names', not both");
      }
      if (fieldNames.length > 0) {
        const resolvedIDs = await resolveFieldNamesToIDs(ctx, owner, ownerType, projectNumber, fieldNames, 'fields');
        fields = fields.concat(resolvedIDs);
      }
      let item;
      try {
        item = await ctx.client.get(`${base}/items/${itemID}`, {
          query: fields.length > 0 ? { fields: fields.join(',') } : undefined,
          signal: ctx.signal,
        });
      } catch (error) {
        fail(`failed to get project item: ${describe(error)}`);
      }
      return { method, item: minimalProjectItem(item) };
    }
    default:
      fail(`unknown method: ${method}`);
  }
  return undefined;
}

/* ---------- projects_list ---------- */

async function listProjectsMethod(args, ctx, owner, ownerType) {
  const query = optionalString(args, 'query');
  const pagination = projectPagination(args);
  const restQuery = { ...pagination };
  if (query !== undefined) restQuery.q = query;

  const projects = [];

  if (ownerType === '') {
    let userOk = false;
    let orgOk = false;
    let pageInfo;
    try {
      const page = await restGet(ctx, `/users/${seg(owner)}/projectsV2`, restQuery);
      for (const project of asArray(page.json)) {
        projects.push({ ...minimalProject(project), owner_type: 'user' });
      }
      userOk = true;
      pageInfo = pageInfoFromResponse(page.response);
    } catch {
      // Ignore: the owner may be an organization.
    }
    try {
      const page = await restGet(ctx, `/orgs/${seg(owner)}/projectsV2`, restQuery);
      for (const project of asArray(page.json)) {
        projects.push({ ...minimalProject(project), owner_type: 'org' });
      }
      orgOk = true;
      pageInfo = pageInfoFromResponse(page.response);
    } catch {
      // Ignore: the owner may be a user.
    }
    if (!userOk && !orgOk) {
      fail(`failed to list projects for owner '${owner}': not found as user or organization`);
    }
    const out = {
      projects,
      note:
        "Results include both user and org projects. Each project includes 'owner_type' field. Pagination is limited when owner_type is not specified - specify 'owner_type' for full pagination support.",
    };
    if (pageInfo !== undefined) out.pageInfo = pageInfo;
    return { method: 'list_projects', projects: out };
  }

  const path = ownerType === 'org' ? `/orgs/${seg(owner)}/projectsV2` : `/users/${seg(owner)}/projectsV2`;
  let page;
  try {
    page = await restGet(ctx, path, restQuery);
  } catch (error) {
    fail(`failed to list projects: ${describe(error)}`);
  }
  for (const project of asArray(page.json)) {
    projects.push({ ...minimalProject(project), owner_type: ownerType });
  }
  return {
    method: 'list_projects',
    projects: { projects, pageInfo: pageInfoFromResponse(page.response) },
  };
}

async function listProjectFieldsMethod(ctx, owner, ownerType, projectNumber, args) {
  const base = projectPath(ownerType, owner, projectNumber);
  let page;
  try {
    page = await restGet(ctx, `${base}/fields`, projectPagination(args));
  } catch (error) {
    fail(`failed to list project fields: ${describe(error)}`);
  }
  return {
    method: 'list_project_fields',
    fields: {
      fields: asArray(page.json).map(projectFieldOutput),
      pageInfo: pageInfoFromResponse(page.response),
    },
  };
}

async function listProjectItemsMethod(ctx, owner, ownerType, projectNumber, args) {
  const query = optionalString(args, 'query');
  let fields = optionalIntArray(args, 'fields');
  const fieldNames = optionalStringArray(args, 'field_names');
  if (fields.length > 0 && fieldNames.length > 0) {
    fail("provide either 'fields' or 'field_names', not both");
  }
  if (fieldNames.length > 0) {
    const resolvedIDs = await resolveFieldNamesToIDs(ctx, owner, ownerType, projectNumber, fieldNames, 'fields');
    fields = fields.concat(resolvedIDs);
  }
  const restQuery = projectPagination(args);
  if (query !== undefined) restQuery.q = query;
  if (fields.length > 0) restQuery.fields = fields.join(',');

  const base = projectPath(ownerType, owner, projectNumber);
  let page;
  try {
    page = await restGet(ctx, `${base}/items`, restQuery);
  } catch (error) {
    fail(`${PROJECT_LIST_FAILED}: ${describe(error)}`);
  }
  return {
    method: 'list_project_items',
    items: {
      items: asArray(page.json).map(minimalProjectItem),
      pageInfo: pageInfoFromResponse(page.response),
    },
  };
}

async function listProjectStatusUpdatesMethod(ctx, owner, ownerType, projectNumber, args) {
  if (ownerType !== 'user' && ownerType !== 'org') {
    fail(`invalid owner_type ${quote(ownerType)}: must be "user" or "org"`);
  }
  const perPage = optionalProjectsPerPage(args);
  const after = optionalString(args, 'after');
  const scope = ownerType === 'org' ? 'organization' : 'user';
  const query = `query($owner: String!, $projectNumber: Int!, $first: Int!, $after: String) {
  ${scope}(login: $owner) {
    projectV2(number: $projectNumber) {
      public
      statusUpdates(first: $first, after: $after, orderBy: {field: CREATED_AT, direction: DESC}) {
        nodes { id body status createdAt startDate targetDate creator { login } }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
}`;
  let data;
  try {
    data = await ctx.client.graphql(
      query,
      { owner, projectNumber, first: perPage, after: after ?? null },
      { signal: ctx.signal },
    );
  } catch (error) {
    fail(`${PROJECT_STATUS_UPDATE_LIST_FAILED}: ${describe(error)}`);
  }
  const connection = data?.[scope]?.projectV2?.statusUpdates;
  return {
    method: 'list_project_status_updates',
    status_updates: {
      statusUpdates: asArray(connection?.nodes).map(statusUpdateOutput),
      pageInfo: graphqlPageInfo(connection),
    },
  };
}

async function listProjectViewsMethod(ctx, owner, ownerType, projectNumber, args) {
  if (ownerType !== 'user' && ownerType !== 'org') {
    fail(`invalid owner_type ${quote(ownerType)}: must be "user" or "org"`);
  }
  const perPage = optionalProjectsPerPage(args);
  const after = optionalString(args, 'after');
  const before = optionalString(args, 'before');
  if (after !== undefined && before !== undefined) fail("provide either 'after' or 'before', not both");

  const variables = { owner, projectNumber, first: null, after: null, last: null, before: null };
  if (before !== undefined) {
    variables.last = perPage;
    variables.before = before;
  } else {
    variables.first = perPage;
    if (after !== undefined) variables.after = after;
  }

  const scope = ownerType === 'org' ? 'organization' : 'user';
  const query = `query($owner: String!, $projectNumber: Int!, $first: Int, $after: String, $last: Int, $before: String) {
  ${scope}(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      public
      views(first: $first, after: $after, last: $last, before: $before) {
        nodes { ${VIEW_NODE_SELECTION} }
        pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
      }
    }
  }
}`;
  let data;
  try {
    data = await ctx.client.graphql(query, variables, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_VIEW_LIST_FAILED}: ${describe(error)}`);
  }
  const project = data?.[scope]?.projectV2;
  if (project?.id == null || project.id === '') {
    fail(`${PROJECT_VIEW_LIST_FAILED}: project was not found`);
  }
  return {
    method: 'list_project_views',
    views: {
      views: asArray(project.views?.nodes).map(projectViewOutput),
      pageInfo: graphqlPageInfo(project.views),
    },
  };
}

/** List GitHub Projects resources. */
async function projectsList(args, ctx) {
  const method = requireString(args, 'method');
  const owner = requireString(args, 'owner');
  const ownerTypeRaw = optionalString(args, 'owner_type') ?? '';

  if (method === 'list_projects') {
    return listProjectsMethod(args, ctx, owner, ownerTypeRaw);
  }
  if (!PROJECT_ITEM_LIST_METHODS.includes(method)) fail(`unknown method: ${method}`);

  const projectNumber = requireInt(args, 'project_number');
  const ownerType = ownerTypeRaw === '' ? await detectOwnerType(ctx, owner, projectNumber) : ownerTypeRaw;

  switch (method) {
    case 'list_project_fields':
      return listProjectFieldsMethod(ctx, owner, ownerType, projectNumber, args);
    case 'list_project_items':
      return listProjectItemsMethod(ctx, owner, ownerType, projectNumber, args);
    case 'list_project_status_updates':
      return listProjectStatusUpdatesMethod(ctx, owner, ownerType, projectNumber, args);
    default:
      return listProjectViewsMethod(ctx, owner, ownerType, projectNumber, args);
  }
}

/* ---------- projects_write ---------- */

/** `addProjectItem` (projects.go:1636). */
async function addProjectItemMethod(ctx, owner, ownerType, projectNumber, itemOwner, itemRepo, itemNumber, itemType) {
  if (itemType !== 'issue' && itemType !== 'pull_request') {
    fail("item_type must be either 'issue' or 'pull_request'");
  }
  const lookup =
    itemType === 'issue'
      ? { field: 'issue', query: 'issue(number: $itemNumber)', error: 'failed to resolve issue' }
      : { field: 'pullRequest', query: 'pullRequest(number: $itemNumber)', error: 'failed to resolve pull request' };

  const resolveQuery = `query($owner: String!, $repo: String!, $itemNumber: Int!) {
  repository(owner: $owner, name: $repo) { ${lookup.query} { id } }
}`;
  let resolved;
  try {
    resolved = await ctx.client.graphql(
      resolveQuery,
      { owner: itemOwner, repo: itemRepo, itemNumber },
      { signal: ctx.signal },
    );
  } catch (error) {
    fail(`${lookup.error} ${itemOwner}/${itemRepo}#${itemNumber}: ${describe(error)}`);
  }
  const contentID = resolved?.repository?.[lookup.field]?.id;
  if (contentID == null || contentID === '') {
    fail(`failed to resolve ${itemType}: content was not found`);
  }

  const projectID = await resolveProjectNodeID(ctx, owner, ownerType, projectNumber);

  const mutation = `mutation($input: AddProjectV2ItemByIdInput!) {
  addProjectV2ItemById(input: $input) { item { id fullDatabaseId } }
}`;
  let data;
  try {
    data = await ctx.client.graphql(
      mutation,
      { input: { projectId: projectID, contentId: contentID } },
      { signal: ctx.signal },
    );
  } catch (error) {
    fail(`${PROJECT_ADD_FAILED}: ${describe(error)}`);
  }
  const item = data?.addProjectV2ItemById?.item;
  const added = {
    id: item?.id == null ? null : String(item.id),
    message: `Successfully added ${itemType} ${itemOwner}/${itemRepo}#${itemNumber} to project ${owner}/${projectNumber}`,
  };
  if (item?.fullDatabaseId !== undefined && item?.fullDatabaseId !== null && item.fullDatabaseId !== '') {
    added.full_database_id = String(item.fullDatabaseId);
    const parsed = Number(item.fullDatabaseId);
    if (Number.isFinite(parsed)) added.item_id = parsed;
  }
  return { method: 'add_project_item', added };
}

/** `buildIssueFieldUpdate` (projects.go:2445). */
function buildIssueFieldUpdate(field, value) {
  if (!['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT'].includes(field.dataType)) {
    failStructured(
      'unsupported_field_type',
      field.name,
      `attached Issue Field ${quote(field.name)} has unsupported data type ${quote(field.dataType)}`,
      undefined,
    );
  }
  if (field.issueFieldID === '') {
    failStructured(
      'missing_field_metadata',
      field.name,
      `attached Issue Field ${quote(field.name)} is missing its Issue Field node ID`,
      undefined,
    );
  }
  const input = { fieldId: field.issueFieldID };
  if (value === null || value === undefined) {
    input.delete = true;
    return input;
  }
  const invalid = (hint) =>
    failStructured(
      'invalid_field_value',
      field.name,
      `invalid value for attached Issue Field ${quote(field.name)}: ${hint}`,
      undefined,
    );
  switch (field.dataType) {
    case 'TEXT':
      if (typeof value !== 'string') invalid('value must be a string');
      input.textValue = value;
      break;
    case 'NUMBER':
      if (typeof value !== 'number') invalid('value must be a number');
      input.numberValue = value;
      break;
    case 'DATE':
      if (typeof value !== 'string') invalid('value must be a date string in YYYY-MM-DD format');
      if (!isDateOnly(value)) invalid('value must be a valid date in YYYY-MM-DD format');
      input.dateValue = value;
      break;
    default: {
      if (typeof value !== 'string' || value === '') invalid('value must be a non-empty option name');
      input.singleSelectOptionId = resolveSingleSelectOptionByName(field, value);
    }
  }
  return input;
}

/** `buildUpdateProjectItem` (projects.go:2341). */
async function buildUpdateProjectItem(ctx, owner, ownerType, projectNumber, input) {
  if (input === null || input === undefined) fail('updated_field must be an object');
  if (!Object.prototype.hasOwnProperty.call(input, 'value')) fail('updated_field.value is required');

  const hasID = Object.prototype.hasOwnProperty.call(input, 'id');
  const hasName = Object.prototype.hasOwnProperty.call(input, 'name');
  if (hasID && hasName) fail('updated_field must set either id or name, not both');
  if (!hasID && !hasName) fail('updated_field requires either id or name');

  let valueField = input.value;
  let fieldID;
  let resolved;

  if (hasID) {
    const numeric = Number(input.id);
    if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) {
      fail(`updated_field.id: value must be a valid integer (got ${input.id})`);
    }
    fieldID = numeric;
  } else {
    const fieldName = input.name;
    if (typeof fieldName !== 'string' || fieldName === '') {
      fail('updated_field.name must be a non-empty string');
    }
    resolved = await resolveProjectFieldByName(ctx, owner, ownerType, projectNumber, fieldName, '');
    if (['TEXT', 'NUMBER', 'DATE', 'SINGLE_SELECT'].includes(resolved.dataType)) {
      resolved = await resolveIssueFieldForUpdate(ctx, owner, ownerType, projectNumber, resolved);
      if (resolved.isIssueField) {
        return { issueField: buildIssueFieldUpdate(resolved, valueField) };
      }
    }
    const parsedID = Number(resolved.id);
    if (!Number.isFinite(parsedID)) {
      fail(`resolved field ${quote(resolved.name)} has non-numeric ID ${quote(resolved.id)}; pass updated_field.id directly`);
    }
    fieldID = parsedID;
  }

  if (resolved !== undefined && resolved.dataType === 'SINGLE_SELECT' && typeof valueField === 'string' && valueField !== '') {
    try {
      valueField = resolveSingleSelectOptionByName(resolved, valueField);
    } catch (error) {
      if (!resolved.options.some((option) => option.id === valueField)) throw error;
    }
  }

  return { payload: { fields: [{ id: fieldID, value: valueField }] } };
}

/**
 * GraphQL call that also sends the `GraphQL-Features` header.
 *
 * `client.graphql()` forwards only `signal`/`strict` and hard-codes its own
 * headers, so a feature-gated mutation has to go through `client.request`
 * directly. This mirrors `ghcontext.WithGraphQLFeatures` upstream.
 */
async function graphqlWithFeatures(ctx, query, variables, features) {
  const { json } = await ctx.client.request('POST', ctx.client.graphqlUrl, {
    absolute: true,
    body: { query, variables },
    signal: ctx.signal,
    headers: { 'content-type': 'application/json', 'GraphQL-Features': features.join(',') },
  });
  if (json && Array.isArray(json.errors) && json.errors.length > 0) {
    const error = new GitHubApiError(json.errors.map((entry) => entry.message).join('; '), {
      method: 'POST',
      url: ctx.client.graphqlUrl,
      body: json,
      errors: json.errors,
    });
    error.data = json.data ?? null;
    if (json.data == null) throw error;
  }
  return json?.data ?? null;
}

/** `SetIssueFieldValues` (issues_granular.go:934). */
async function setIssueFieldValues(ctx, issueID, issueFields) {
  const mutation = `mutation($input: SetIssueFieldValueInput!) {
  setIssueFieldValue(input: $input) { issue { id url } }
}`;
  let data;
  try {
    // Gated behind the `update_issue_suggestions` feature flag (projects.go:1484).
    data = await graphqlWithFeatures(
      ctx,
      mutation,
      { input: { issueId: issueID, issueFields } },
      ['update_issue_suggestions'],
    );
  } catch (error) {
    fail(`failed to set issue field value: ${describe(error)}`);
  }
  const issue = data?.setIssueFieldValue?.issue;
  return { id: issue?.id == null ? '' : String(issue.id), url: issue?.url == null ? '' : String(issue.url) };
}

async function updateProjectItemMethod(ctx, owner, ownerType, projectNumber, itemID, fieldValue) {
  const built = await buildUpdateProjectItem(ctx, owner, ownerType, projectNumber, fieldValue);

  if (built.issueField !== undefined) {
    const base = projectPath(ownerType, owner, projectNumber);
    let item;
    try {
      item = await ctx.client.get(`${base}/items/${itemID}`, { signal: ctx.signal });
    } catch (error) {
      fail(`failed to get project item: ${describe(error)}`);
    }
    const issueID = item?.content?.node_id ?? item?.content?.id;
    if (issueID === undefined || issueID === null) {
      failStructured('missing_metadata', '', 'project item metadata is missing', undefined);
    }
    const response = await setIssueFieldValues(ctx, issueID, [built.issueField]);
    return { method: 'update_project_item', issue_fields: { id: response.id, html_url: response.url } };
  }

  const base = projectPath(ownerType, owner, projectNumber);
  let updated;
  try {
    updated = await ctx.client.patch(`${base}/items/${itemID}`, built.payload, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_UPDATE_FAILED}: ${describe(error)}`);
  }
  return { method: 'update_project_item', item: minimalProjectItem(updated) };
}

/** `convertProjectFieldValue` (projects_batch.go). */
function convertProjectFieldValue(field, value) {
  if (value === null || value === undefined) return null;
  switch (field.dataType) {
    case 'TEXT':
      if (typeof value !== 'string') fail(`field ${quote(field.name)} is TEXT; value must be a string`);
      return { text: value };
    case 'NUMBER':
      if (typeof value !== 'number') fail(`field ${quote(field.name)} is NUMBER; value must be a number`);
      return { number: value };
    case 'DATE':
      if (typeof value !== 'string') fail(`field ${quote(field.name)} is DATE; value must be a YYYY-MM-DD string`);
      if (!isDateOnly(value)) {
        fail(`field ${quote(field.name)} is DATE; value ${quote(value)} is not in YYYY-MM-DD format`);
      }
      return { date: value };
    case 'SINGLE_SELECT': {
      if (typeof value !== 'string' || value === '') {
        fail(`field ${quote(field.name)} is SINGLE_SELECT; value must be a non-empty string (option name or ID)`);
      }
      let optionID;
      try {
        optionID = resolveSingleSelectOptionByName(field, value);
      } catch (error) {
        if (!field.options.some((option) => option.id === value)) throw error;
        optionID = value;
      }
      return { singleSelectOptionId: optionID };
    }
    case 'ITERATION':
      if (typeof value !== 'string' || value === '') {
        fail(`field ${quote(field.name)} is ITERATION; value must be a non-empty iteration ID string`);
      }
      return { iterationId: value };
    default:
      fail(
        `field ${quote(field.name)} has unsupported data type ${quote(field.dataType)} for update_project_items; use update_project_item instead`,
      );
  }
  return undefined;
}

/** `updateProjectItemsBatch` (projects_batch.go:66). */
async function updateProjectItemsBatch(ctx, owner, ownerType, projectNumber, args) {
  const items = args?.items;
  if (items === undefined || items === null) fail('missing required parameter: items');
  if (!Array.isArray(items)) fail('items must be an array');
  if (items.length === 0) fail('items must contain at least one entry');
  if (items.length > MAX_PROJECT_ITEMS_PER_BATCH) {
    fail(`items exceeds maximum of ${MAX_PROJECT_ITEMS_PER_BATCH} entries per call (got ${items.length})`);
  }

  const rawField = args?.updated_field;
  if (rawField === undefined || rawField === null) fail('missing required parameter: updated_field');
  if (typeof rawField !== 'object' || Array.isArray(rawField)) fail('updated_field must be an object');
  if (!Object.prototype.hasOwnProperty.call(rawField, 'value')) fail('updated_field.value is required');
  const hasID = Object.prototype.hasOwnProperty.call(rawField, 'id');
  const hasName = Object.prototype.hasOwnProperty.call(rawField, 'name');
  if (hasID && hasName) fail('updated_field must set either id or name, not both');
  if (!hasID && !hasName) fail('updated_field requires either id or name');

  let fieldID;
  let fieldName;
  if (hasID) {
    const id = toPositiveInt(rawField.id, undefined);
    if (id === undefined) fail(`updated_field.id: value must be greater than zero (got ${rawField.id})`);
    fieldID = id;
  } else {
    if (typeof rawField.name !== 'string' || rawField.name === '') {
      fail('updated_field.name must be a non-empty string');
    }
    fieldName = rawField.name;
  }

  const results = items.map((entry, index) => ({ index, entry }));
  const parsed = [];
  for (const { index, entry } of results) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      parsed.push({ index, status: 'failed', error: { code: 'invalid_item', message: `items[${index}] must be an object` } });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'updated_field')) {
      parsed.push({
        index,
        status: 'failed',
        error: {
          code: 'invalid_item',
          message: `items[${index}].updated_field is not supported; use the top-level updated_field`,
        },
      });
      continue;
    }
    const ref = {};
    for (const key of ['node_id', 'item_id', 'item_owner', 'item_repo', 'issue_number']) {
      if (Object.prototype.hasOwnProperty.call(entry, key)) ref[key] = entry[key];
    }
    const hasNode = ref.node_id !== undefined;
    const hasItem = ref.item_id !== undefined;
    const hasIssue = ref.item_owner !== undefined || ref.item_repo !== undefined || ref.issue_number !== undefined;
    const refCount = (hasNode ? 1 : 0) + (hasItem ? 1 : 0) + (hasIssue ? 1 : 0);
    if (refCount === 0) {
      parsed.push({
        index,
        status: 'failed',
        ref,
        error: {
          code: 'invalid_item_ref',
          message: 'each item requires exactly one of node_id, item_id, or item_owner + item_repo + issue_number',
        },
      });
      continue;
    }
    if (refCount > 1) {
      parsed.push({
        index,
        status: 'failed',
        ref,
        error: {
          code: 'invalid_item_ref',
          message:
            'each item must set exactly one of node_id, item_id, or item_owner + item_repo + issue_number, not more than one',
        },
      });
      continue;
    }
    if (hasIssue && (ref.item_owner === undefined || ref.item_repo === undefined || ref.issue_number === undefined)) {
      parsed.push({
        index,
        status: 'failed',
        ref,
        error: {
          code: 'invalid_item_ref',
          message:
            'item_owner, item_repo, and issue_number must all be provided together: each item must set exactly one of node_id, item_id, or item_owner + item_repo + issue_number',
        },
      });
      continue;
    }
    parsed.push({ index, status: 'pending', ref, entry });
  }

  const failed = parsed.filter((entry) => entry.status === 'failed');

  const projectID = await resolveProjectNodeID(ctx, owner, ownerType, projectNumber);
  let field;
  if (fieldName !== undefined) {
    field = await resolveProjectFieldByName(ctx, owner, ownerType, projectNumber, fieldName, '');
  } else {
    const all = await listAllProjectFields(ctx, owner, ownerType, projectNumber);
    field = all.find((candidate) => String(candidate.id) === String(fieldID));
    if (field === undefined) {
      failStructured(
        'field_not_found',
        String(fieldID),
        `no project field with id ${fieldID} on project ${owner}#${projectNumber}; see candidates for available fields`,
        all.map((candidate) => ({ id: candidate.id, name: candidate.name, data_type: candidate.dataType })),
      );
    }
  }

  const value = convertProjectFieldValue(field, rawField.value);

  const writes = [];
  const seen = new Map();
  for (const entry of parsed) {
    if (entry.status === 'failed') continue;
    let itemID = null;
    try {
      if (entry.ref.node_id !== undefined) {
        if (typeof entry.ref.node_id !== 'string' || entry.ref.node_id === '') {
          throw new Error('node_id must be a non-empty string');
        }
        itemID = entry.ref.node_id;
      } else if (entry.ref.item_id !== undefined) {
        const id = toPositiveInt(entry.ref.item_id, undefined);
        if (id === undefined) {
          throw new Error(`item_id: value must be greater than zero (got ${entry.ref.item_id})`);
        }
        const base = projectPath(ownerType, owner, projectNumber);
        const item = await ctx.client.get(`${base}/items/${id}`, { signal: ctx.signal });
        if (!item?.node_id) throw new Error(`project item ${id}: response did not include a node id`);
        itemID = item.node_id;
      } else {
        const resolvedItem = await resolveProjectItemByIssueNumber(
          ctx,
          projectID,
          entry.ref.item_owner,
          entry.ref.item_repo,
          entry.ref.issue_number,
        );
        itemID = resolvedItem.nodeID;
      }
    } catch (error) {
      entry.status = 'failed';
      entry.error = { code: 'resolution_failed', message: describe(error) };
      continue;
    }
    if (seen.has(itemID)) {
      entry.status = 'failed';
      entry.error = {
        code: 'duplicate_target',
        message: `items[${entry.index}] targets the same project item as items[${seen.get(itemID)}]; each item may only be written once per call`,
      };
      continue;
    }
    seen.set(itemID, entry.index);
    writes.push({ index: entry.index, itemID, ref: entry.ref });
  }

  const writeResults = new Map();
  const clear = value === null;
  const mutationName = clear ? 'clearProjectV2ItemFieldValue' : 'updateProjectV2ItemFieldValue';
  for (let offset = 0; offset < writes.length; offset += BATCH_WIRE_CHUNK_SIZE) {
    const chunk = writes.slice(offset, offset + BATCH_WIRE_CHUNK_SIZE);
    const declarations = chunk.map((_, i) => `$input${i === 0 ? '' : i}: UpdateProjectV2ItemFieldValueInput!`);
    const fields = chunk
      .map((entry, i) => `  item${i}: ${mutationName}(input: $input${i === 0 ? '' : i}) { projectV2Item { id fullDatabaseId } }`)
      .join('\n');
    const query = `mutation(${declarations.join(', ')}) {\n${fields}\n}`;
    const variables = {};
    chunk.forEach((entry, i) => {
      const input = { projectId: projectID, itemId: entry.itemID, fieldId: field.nodeId };
      if (!clear) input.value = value;
      variables[`input${i === 0 ? '' : i}`] = input;
    });
    let data;
    try {
      data = await ctx.client.graphql(query, variables, { signal: ctx.signal });
    } catch (error) {
      for (const entry of chunk) {
        writeResults.set(entry.index, { status: 'unknown', error: { code: 'mutation_unconfirmed', message: describe(error) } });
      }
      continue;
    }
    chunk.forEach((entry, i) => {
      const item = data?.[`item${i}`]?.projectV2Item;
      if (item?.id === undefined || item?.id === null || item.id === '') {
        writeResults.set(entry.index, {
          status: 'unknown',
          error: { code: 'mutation_unconfirmed', message: 'mutation response did not confirm the write' },
        });
        return;
      }
      const identity = { node_id: String(item.id) };
      if (item.fullDatabaseId !== undefined && item.fullDatabaseId !== null && item.fullDatabaseId !== '') {
        identity.full_database_id = String(item.fullDatabaseId);
      }
      if (entry.ref.item_id !== undefined) identity.item_id = toPositiveInt(entry.ref.item_id, undefined);
      writeResults.set(entry.index, { status: 'succeeded', item: omitEmpty(identity) });
    });
  }

  const output = [];
  let succeeded = 0;
  let failedCount = 0;
  let unknown = 0;
  for (let index = 0; index < items.length; index += 1) {
    const entry = parsed.find((candidate) => candidate.index === index);
    if (entry !== undefined && entry.status === 'failed') {
      failedCount += 1;
      output.push({ index, status: 'failed', ref: entry.ref, error: entry.error });
      continue;
    }
    const result = writeResults.get(index);
    if (result === undefined) {
      unknown += 1;
      output.push({ index, status: 'unknown', ref: entry?.ref });
      continue;
    }
    if (result.status === 'succeeded') {
      succeeded += 1;
      output.push({ index, status: 'succeeded', item: result.item, ref: entry?.ref });
    } else {
      unknown += 1;
      output.push({ index, status: 'unknown', error: result.error, ref: entry?.ref });
    }
  }

  return {
    method: 'update_project_items',
    batch: {
      total: items.length,
      succeeded,
      failed: failedCount,
      unknown,
      results: output.map((entry) => defined(entry)),
    },
  };
}

/** `createProjectStatusUpdate` (projects.go:1708). */
async function createProjectStatusUpdateMethod(ctx, owner, ownerType, projectNumber, args) {
  if (ownerType !== 'user' && ownerType !== 'org') {
    fail(`invalid owner_type ${quote(ownerType)}: must be "user" or "org"`);
  }
  const body = optionalString(args, 'body');
  const status = optionalString(args, 'status');
  const startDate = optionalString(args, 'start_date');
  const targetDate = optionalString(args, 'target_date');
  if (status !== undefined && !PROJECT_STATUSES.includes(status)) {
    fail(`invalid status ${quote(status)}: must be one of INACTIVE, ON_TRACK, AT_RISK, OFF_TRACK, COMPLETE`);
  }
  if (startDate !== undefined && !isDateOnly(startDate)) {
    fail(`invalid start_date ${quote(startDate)}: must be YYYY-MM-DD format`);
  }
  if (targetDate !== undefined && !isDateOnly(targetDate)) {
    fail(`invalid target_date ${quote(targetDate)}: must be YYYY-MM-DD format`);
  }

  const projectID = await resolveProjectNodeID(ctx, owner, ownerType, projectNumber);
  const input = { projectId: projectID };
  if (body !== undefined) input.body = body;
  if (status !== undefined) input.status = status;
  if (startDate !== undefined) input.startDate = startDate;
  if (targetDate !== undefined) input.targetDate = targetDate;

  const mutation = `mutation($input: CreateProjectV2StatusUpdateInput!) {
  createProjectV2StatusUpdate(input: $input) {
    statusUpdate { id body status createdAt startDate targetDate creator { login } }
  }
}`;
  let data;
  try {
    data = await ctx.client.graphql(mutation, { input }, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_STATUS_UPDATE_CREATE_FAILED}: ${describe(error)}`);
  }
  return {
    method: 'create_project_status_update',
    status_update: statusUpdateOutput(data?.createProjectV2StatusUpdate?.statusUpdate),
  };
}

/** `projectViewVisibleFieldsInput` (projects.go:2043). */
async function projectViewVisibleFieldsInput(ctx, args, owner, ownerType, projectNumber) {
  const hasVisibleFields = Object.prototype.hasOwnProperty.call(args ?? {}, 'visible_fields');
  const hasVisibleFieldNames = Object.prototype.hasOwnProperty.call(args ?? {}, 'visible_field_names');
  if (!hasVisibleFields && !hasVisibleFieldNames) return undefined;

  const databaseIDs = optionalIntArray(args, 'visible_fields');
  const names = optionalStringArray(args, 'visible_field_names');
  if (databaseIDs.length > 0 && names.length > 0) {
    fail("provide either 'visible_fields' or 'visible_field_names', not both");
  }
  if (databaseIDs.length === 0 && names.length === 0) return { visibleFieldIds: [] };

  const all = await listAllProjectFields(ctx, owner, ownerType, projectNumber);
  let resolved;
  if (names.length > 0) {
    resolved = resolveFieldsByName(all, owner, projectNumber, names, 'visible_fields');
  } else {
    const byDatabaseID = new Map();
    for (const field of all) {
      const id = Number(field.id);
      if (Number.isFinite(id)) byDatabaseID.set(id, field);
    }
    resolved = databaseIDs.map((id) => {
      const field = byDatabaseID.get(id);
      if (field === undefined) {
        fail(`project field database ID ${id} was not found on project ${owner}#${projectNumber}`);
      }
      return field;
    });
  }

  const nodeIDs = [];
  const seen = new Set();
  for (const field of resolved) {
    if (seen.has(field.nodeId)) fail(`project field ${quote(field.name)} is included more than once`);
    seen.add(field.nodeId);
    nodeIDs.push(field.nodeId);
  }
  return { visibleFieldIds: nodeIDs };
}

function projectViewRequestsVisibleFields(args) {
  const databaseIDs = optionalIntArray(args, 'visible_fields');
  if (databaseIDs.length > 0) return true;
  return optionalStringArray(args, 'visible_field_names').length > 0;
}

/** `verifyProjectViewParent` (projects.go:2190). */
async function verifyProjectViewParent(ctx, viewID, owner, ownerType, projectNumber) {
  let expectedProjectID;
  try {
    expectedProjectID = await resolveProjectNodeID(ctx, owner, ownerType, projectNumber);
  } catch (error) {
    fail(`failed to resolve requested project: ${describe(error)}`);
  }
  if (expectedProjectID === null || expectedProjectID === '') fail('requested project was not found');

  const query = `query($id: ID!) {
  node(id: $id) { ... on ProjectV2View { id layout project { id } } }
}`;
  let data;
  try {
    data = await ctx.client.graphql(query, { id: viewID }, { signal: ctx.signal });
  } catch (error) {
    fail(`failed to resolve project view: ${describe(error)}`);
  }
  const view = data?.node;
  if (view?.id == null || view.id === '') fail('node is not a ProjectV2View or was not found');
  if (String(view.project?.id ?? '') !== String(expectedProjectID)) {
    fail('project view does not belong to the requested project');
  }
  return view.layout;
}

/** `createProjectView` (projects.go:2117). */
async function createProjectViewMethod(ctx, args, owner, ownerType, projectNumber) {
  const name = requireString(args, 'name');
  if (name.trim() === '') fail('name must not be empty');
  const layoutName = requireString(args, 'layout');
  const layout = parseProjectViewLayout(layoutName);
  const hasFilter = Object.prototype.hasOwnProperty.call(args ?? {}, 'filter');
  const filter = hasFilter ? args.filter : undefined;
  if (layout === 'ROADMAP_LAYOUT' && projectViewRequestsVisibleFields(args)) {
    fail('visible fields are not supported for roadmap views');
  }

  const configuration = await projectViewVisibleFieldsInput(ctx, args, owner, ownerType, projectNumber);
  const projectID = await resolveProjectNodeID(ctx, owner, ownerType, projectNumber);
  if (projectID === null || projectID === '') fail(`${PROJECT_VIEW_CREATE_FAILED}: project was not found`);

  const mutation = `mutation($input: CreateProjectV2ViewInput!) {
  createProjectV2View(input: $input) {
    projectV2View { ${VIEW_NODE_SELECTION} }
  }
}`;
  const input = defined({ projectId: projectID, name, layout, configuration });
  let data;
  try {
    data = await ctx.client.graphql(mutation, { input }, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_VIEW_CREATE_FAILED}: ${describe(error)}`);
  }
  let view = data?.createProjectV2View?.projectV2View;
  if (view?.id == null || view.id === '') {
    fail(`${PROJECT_VIEW_CREATE_FAILED}: response did not include a project view`);
  }

  if (hasFilter && filter !== null && filter !== undefined) {
    const updateMutation = `mutation($input: UpdateProjectV2ViewInput!) {
  updateProjectV2View(input: $input) {
    projectV2View { ${VIEW_NODE_SELECTION} }
  }
}`;
    try {
      const updated = await ctx.client.graphql(
        updateMutation,
        { input: { viewId: String(view.id), filter: String(filter) } },
        { signal: ctx.signal },
      );
      view = updated?.updateProjectV2View?.projectV2View ?? view;
    } catch (error) {
      try {
        await deleteProjectViewByID(ctx, String(view.id));
      } catch (cleanupError) {
        fail(
          `${PROJECT_VIEW_CREATE_FAILED}: failed to set filter: ${describe(error)}; failed to clean up created view ${String(view.id)}: ${describe(cleanupError)}`,
        );
      }
      fail(`${PROJECT_VIEW_CREATE_FAILED}: failed to set filter: ${describe(error)}; created view was cleaned up`);
    }
  }
  return { method: 'create_project_view', view: projectViewOutput(view) };
}

/** `updateProjectView` (projects.go:2212). */
async function updateProjectViewMethod(ctx, args, owner, ownerType, projectNumber) {
  const viewID = requireString(args, 'view_id');
  const hasName = Object.prototype.hasOwnProperty.call(args ?? {}, 'name');
  const hasLayout = Object.prototype.hasOwnProperty.call(args ?? {}, 'layout');
  const hasFilter = Object.prototype.hasOwnProperty.call(args ?? {}, 'filter');
  const hasVisibleFields = Object.prototype.hasOwnProperty.call(args ?? {}, 'visible_fields');
  const hasVisibleFieldNames = Object.prototype.hasOwnProperty.call(args ?? {}, 'visible_field_names');
  if (!hasName && !hasLayout && !hasFilter && !hasVisibleFields && !hasVisibleFieldNames) {
    fail('update_project_view requires at least one of name, layout, filter, visible_fields, or visible_field_names');
  }
  const name = hasName ? args.name : undefined;
  if (hasName && (typeof name !== 'string' || name.trim() === '')) fail('name must not be empty');

  const input = { viewId: viewID };
  if (hasName) input.name = name;
  let layout;
  if (hasLayout) {
    layout = parseProjectViewLayout(args.layout);
    input.layout = layout;
  }
  if (hasFilter) input.filter = args.filter === null || args.filter === undefined ? '' : String(args.filter);

  const currentLayout = await verifyProjectViewParent(ctx, viewID, owner, ownerType, projectNumber);
  const effectiveLayout = layout ?? currentLayout;
  if (effectiveLayout === 'ROADMAP_LAYOUT' && projectViewRequestsVisibleFields(args)) {
    fail('visible fields are not supported for roadmap views');
  }

  const configuration = await projectViewVisibleFieldsInput(ctx, args, owner, ownerType, projectNumber);
  if (configuration !== undefined) input.configuration = configuration;

  const mutation = `mutation($input: UpdateProjectV2ViewInput!) {
  updateProjectV2View(input: $input) {
    projectV2View { ${VIEW_NODE_SELECTION} }
  }
}`;
  let data;
  try {
    data = await ctx.client.graphql(mutation, { input }, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_VIEW_UPDATE_FAILED}: ${describe(error)}`);
  }
  const view = data?.updateProjectV2View?.projectV2View;
  if (view?.id == null || view.id === '') {
    fail(`${PROJECT_VIEW_UPDATE_FAILED}: response did not include a project view`);
  }
  return { method: 'update_project_view', view: projectViewOutput(view) };
}

/** `deleteProjectViewByID` (projects.go:2289). */
async function deleteProjectViewByID(ctx, viewID) {
  const mutation = `mutation($input: DeleteProjectV2ViewInput!) {
  deleteProjectV2View(input: $input) { projectV2View { id } }
}`;
  const data = await ctx.client.graphql(mutation, { input: { viewId: viewID } }, { signal: ctx.signal });
  const id = data?.deleteProjectV2View?.projectV2View?.id;
  if (id == null || id === '') throw new Error('response did not include the deleted project view');
}

/** `deleteProjectView` (projects.go:2307). */
async function deleteProjectViewMethod(ctx, args, owner, ownerType, projectNumber) {
  const viewID = requireString(args, 'view_id');
  try {
    await verifyProjectViewParent(ctx, viewID, owner, ownerType, projectNumber);
  } catch (error) {
    fail(`${PROJECT_VIEW_DELETE_FAILED}: ${describe(error)}`);
  }
  try {
    await deleteProjectViewByID(ctx, viewID);
  } catch (error) {
    fail(`${PROJECT_VIEW_DELETE_FAILED}: ${describe(error)}`);
  }
  return { method: 'delete_project_view', deleted_view: { deleted_view_id: viewID } };
}

/** `createProject` (projects.go:2608). */
async function createProjectMethod(ctx, owner, ownerType, args) {
  if (ownerType === '') fail('owner_type is required for create_project');
  if (ownerType !== 'user' && ownerType !== 'org') {
    fail(`invalid owner_type ${quote(ownerType)}: must be "user" or "org"`);
  }
  const title = requireString(args, 'title');

  const scope = ownerType === 'org' ? 'organization' : 'user';
  const ownerQuery = `query($login: String!) { ${scope}(login: $login) { id } }`;
  let ownerData;
  try {
    ownerData = await ctx.client.graphql(ownerQuery, { login: owner }, { signal: ctx.signal });
  } catch (error) {
    fail(`failed to get owner ID: ${describe(error)}`);
  }
  const ownerID = ownerData?.[scope]?.id;
  if (ownerID == null || ownerID === '') fail('failed to get owner ID: owner was not found');

  const mutation = `mutation($input: CreateProjectV2Input!) {
  createProjectV2(input: $input) { projectV2 { id number title url } }
}`;
  let data;
  try {
    data = await ctx.client.graphql(mutation, { input: { ownerId: ownerID, title } }, { signal: ctx.signal });
  } catch (error) {
    fail(`failed to create project: ${describe(error)}`);
  }
  const project = data?.createProjectV2?.projectV2 ?? {};
  return {
    method: 'create_project',
    project: {
      id: project.id == null ? '' : String(project.id),
      number: Number(project.number ?? 0),
      title: project.title == null ? '' : String(project.title),
      html_url: project.url == null ? '' : String(project.url),
    },
  };
}

/** `createIterationField` (projects.go:2671). */
async function createIterationFieldMethod(ctx, args, owner, ownerType, projectNumber) {
  const fieldName = requireString(args, 'field_name');
  const duration = requireInt(args, 'iteration_duration');
  const startDateStr = requireString(args, 'start_date');

  const projectID = await resolveProjectNodeID(ctx, owner, ownerType, projectNumber);

  const createMutation = `mutation($input: CreateProjectV2FieldInput!) {
  createProjectV2Field(input: $input) {
    projectV2Field { ... on ProjectV2IterationField { id name } }
  }
}`;
  let created;
  try {
    created = await ctx.client.graphql(
      createMutation,
      { input: { projectId: projectID, dataType: 'ITERATION', name: fieldName } },
      { signal: ctx.signal },
    );
  } catch (error) {
    fail(`failed to create iteration field: ${describe(error)}`);
  }
  const fieldID = created?.createProjectV2Field?.projectV2Field?.id ?? '';

  if (!isDateOnly(startDateStr)) fail(`failed to parse start_date ${startDateStr}: must be YYYY-MM-DD`);

  const rawIterations = args?.iterations;
  const iterations = [];
  if (Array.isArray(rawIterations)) {
    rawIterations.forEach((item, i) => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        fail(`iterations[${i}] must be an object`);
      }
      if (typeof item.title !== 'string' || item.title === '') {
        fail(`iterations[${i}]: title is required and must be a non-empty string`);
      }
      if (typeof item.start_date !== 'string' || item.start_date === '') {
        fail(`iterations[${i}]: start_date is required and must be a non-empty string`);
      }
      if (typeof item.duration !== 'number' || item.duration <= 0) {
        fail(`iterations[${i}]: duration is required and must be a positive number`);
      }
      if (!isDateOnly(item.start_date)) {
        fail(`iterations[${i}]: failed to parse start_date ${quote(item.start_date)}: must be YYYY-MM-DD`);
      }
      iterations.push({ title: item.title, startDate: item.start_date, duration: item.duration });
    });
  }

  const updateMutation = `mutation($input: UpdateProjectV2FieldInput!) {
  updateProjectV2Field(input: $input) {
    projectV2Field {
      ... on ProjectV2IterationField {
        id
        name
        configuration { iterations { id title startDate duration } }
      }
    }
  }
}`;
  let updated;
  try {
    updated = await ctx.client.graphql(
      updateMutation,
      {
        input: {
          fieldId: fieldID,
          iterationConfiguration: { duration, startDate: startDateStr, iterations },
        },
      },
      { signal: ctx.signal },
    );
  } catch (error) {
    fail(`failed to update iteration configuration: ${describe(error)}`);
  }
  const field = updated?.updateProjectV2Field?.projectV2Field ?? {};
  return {
    method: 'create_iteration_field',
    iteration_field: {
      id: field.id == null ? '' : String(field.id),
      name: field.name == null ? '' : String(field.name),
      configuration: {
        iterations: asArray(field.configuration?.iterations).map((iteration) => ({
          id: iteration?.id == null ? '' : String(iteration.id),
          title: iteration?.title == null ? '' : String(iteration.title),
          start_date: iteration?.startDate == null ? '' : String(iteration.startDate),
          duration: Number(iteration?.duration ?? 0),
        })),
      },
    },
  };
}

/** `deleteProjectItem` (projects.go:1569). */
async function deleteProjectItemMethod(ctx, owner, ownerType, projectNumber, itemID) {
  const base = projectPath(ownerType, owner, projectNumber);
  try {
    await ctx.client.delete(`${base}/items/${itemID}`, { signal: ctx.signal });
  } catch (error) {
    fail(`${PROJECT_DELETE_FAILED}: ${describe(error)}`);
  }
  return { method: 'delete_project_item', deleted_item: { message: 'project item successfully deleted' } };
}

/** Create, update, or delete GitHub Projects resources. */
async function projectsWrite(args, ctx) {
  const method = requireString(args, 'method');
  const owner = requireString(args, 'owner');
  const ownerTypeRaw = optionalString(args, 'owner_type') ?? '';

  if (method === 'create_project') {
    return createProjectMethod(ctx, owner, ownerTypeRaw, args);
  }

  const projectNumber = requireInt(args, 'project_number');
  const ownerType = ownerTypeRaw === '' ? await detectOwnerType(ctx, owner, projectNumber) : ownerTypeRaw;

  switch (method) {
    case 'add_project_item': {
      const itemType = requireString(args, 'item_type');
      const itemOwner = requireString(args, 'item_owner');
      const itemRepo = requireString(args, 'item_repo');
      let itemNumber;
      if (itemType === 'issue') {
        itemNumber = requireInt(args, 'issue_number');
        if (args?.issue_number === undefined) fail("issue_number is required when item_type is 'issue'");
      } else if (itemType === 'pull_request') {
        itemNumber = requireInt(args, 'pull_request_number');
        if (args?.pull_request_number === undefined) {
          fail("pull_request_number is required when item_type is 'pull_request'");
        }
      } else {
        fail("item_type must be either 'issue' or 'pull_request'");
      }
      return addProjectItemMethod(ctx, owner, ownerType, projectNumber, itemOwner, itemRepo, itemNumber, itemType);
    }
    case 'update_project_item': {
      let itemID;
      if (Object.prototype.hasOwnProperty.call(args ?? {}, 'item_id')) {
        itemID = requireInt(args, 'item_id');
      } else {
        const itemOwner = optionalString(args, 'item_owner');
        const itemRepo = optionalString(args, 'item_repo');
        const issueNumber = toPositiveInt(args?.issue_number, undefined);
        if (itemOwner === undefined || itemRepo === undefined || issueNumber === undefined) {
          fail(
            'update_project_item requires either item_id, or item_owner + item_repo + issue_number to resolve the item by issue',
          );
        }
        const projectID = await resolveProjectNodeID(ctx, owner, ownerType, projectNumber);
        const resolved = await resolveProjectItemByIssueNumber(ctx, projectID, itemOwner, itemRepo, issueNumber);
        itemID = resolved.itemID;
      }
      if (args?.updated_field === undefined) fail('missing required parameter: updated_field');
      const fieldValue = args.updated_field;
      if (fieldValue === null || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
        fail('updated_field must be an object');
      }
      return updateProjectItemMethod(ctx, owner, ownerType, projectNumber, itemID, fieldValue);
    }
    case 'update_project_items':
      return updateProjectItemsBatch(ctx, owner, ownerType, projectNumber, args);
    case 'delete_project_item': {
      const itemID = requireInt(args, 'item_id');
      return deleteProjectItemMethod(ctx, owner, ownerType, projectNumber, itemID);
    }
    case 'create_project_status_update':
      return createProjectStatusUpdateMethod(ctx, owner, ownerType, projectNumber, args);
    case 'create_iteration_field':
      return createIterationFieldMethod(ctx, args, owner, ownerType, projectNumber);
    case 'create_project_view':
      return createProjectViewMethod(ctx, args, owner, ownerType, projectNumber);
    case 'update_project_view':
      return updateProjectViewMethod(ctx, args, owner, ownerType, projectNumber);
    case 'delete_project_view':
      return deleteProjectViewMethod(ctx, args, owner, ownerType, projectNumber);
    default:
      fail(`unknown method: ${method}`);
  }
  return undefined;
}

export default {
  create_repository_ruleset: createRepositoryRuleset,
  repository_ruleset_read: repositoryRulesetRead,
  custom_properties_read: customPropertiesRead,
  custom_properties_write: customPropertiesWrite,
  projects_get: projectsGet,
  projects_list: projectsList,
  projects_write: projectsWrite,
};

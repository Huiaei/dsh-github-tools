/**
 * actions.js — 4 tool handlers.
 *
 *   - actions_get
 *   - actions_list
 *   - actions_run_trigger
 *   - get_job_logs
 *
 * Ported from the upstream Go server:
 *   pkg/github/actions.go       (ActionsGet, ActionsList, ActionsRunTrigger, ActionsGetJobLogs
 *                                and their per-method helpers)
 *   pkg/github/actions_types.go (Actions*Output structs, normalizeActionsFields, the two filters)
 *   pkg/github/minimal_types.go (MinimalWorkflowRun / MinimalWorkflowJob projections)
 *   pkg/buffer/buffer.go        (the job-log ring buffer: last N lines + total line count)
 *   pkg/sanitize/sanitize.go    (sanitize.Content, applied to the head-commit message)
 */

import {
  asArray,
  defined,
  fail,
  optionalBoolean,
  optionalString,
  paginationQuery,
  pathSeg,
  requireString,
  seg,
  toPositiveInt,
} from '../util.js';

/** The upstream `--content-window-size` default (cmd/github-mcp-server/main.go). */
const CONTENT_WINDOW_SIZE = 5000;
/** `tail_lines` is forced to 500 when absent or <= 0. */
const DEFAULT_TAIL_LINES = 500;
/** buffer.go truncates any single log line longer than 10 MiB. */
const MAX_LINE_SIZE = 10 * 1024 * 1024;
const TRUNCATED_SUFFIX = '... [TRUNCATED]';

const NOTE_ARTIFACT_DOWNLOAD =
  'The download_url provides a download link for the artifact as a ZIP archive. The link is temporary and expires after a short time.';
const NOTE_RUN_LOGS =
  'The logs_url provides a download link for the complete workflow run logs as a ZIP archive. You can download this archive to extract and examine individual job logs.';
const WARNING_RUN_LOGS =
  'This downloads ALL logs as a ZIP file which can be large and expensive. For debugging failed jobs, consider using get_job_logs with failed_only=true and run_id instead.';
const NOTE_JOB_LOGS_URL =
  'The logs_url provides a download link for the individual job logs in plain text format. Use return_content=true to get the actual log content.';

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * `strconv.ParseInt(value, 10, 64)` — `null` when it would have returned an error.
 * @returns {number|null}
 */
function parseGoInt(value) {
  const text = String(value);
  if (!/^[+-]?\d+$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** The `%v` rendering of the error `strconv.ParseInt` would have returned. */
function parseIntError(value) {
  const quoted = JSON.stringify(String(value));
  if (!/^[+-]?\d+$/.test(String(value))) return `strconv.ParseInt: parsing ${quoted}: invalid syntax`;
  return `strconv.ParseInt: parsing ${quoted}: value out of range`;
}

/** go-github `Response.Status`, e.g. `204 No Content`. */
const REASON_PHRASES = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  205: 'Reset Content',
  304: 'Not Modified',
};

function statusLine(response) {
  const status = response?.status ?? 0;
  const text =
    typeof response?.statusText === 'string' && response.statusText.length > 0 ? response.statusText : (REASON_PHRASES[status] ?? '');
  return `${status} ${text}`.trim();
}

/** `%T`-style type name, used by the `OptionalParam` filter validation message. */
function goTypeName(value) {
  if (value === null) return '<nil>';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return 'float64';
  if (Array.isArray(value)) return '[]interface {}';
  return 'map[string]interface {}';
}

/** `time.RFC3339` — second precision, the offset of the source value preserved. */
function rfc3339(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  const match = /^(.*?)(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  return match ? `${match[1]}${match[2]}` : value;
}

/** `formatMinimalTimestamp` — `""` for a missing/zero timestamp (omitempty drops it). */
function formatMinimalTimestamp(value) {
  return rfc3339(value);
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

const GRAPHIC = /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]/u;
const WHITESPACE = /[\t\n\v\f\r \u0085\u00A0\u2028\u2029\p{Zs}]/u;
const HAN = /\p{Script=Han}/u;

function shouldRemoveRune(codePoint) {
  switch (codePoint) {
    case 0x200b: // ZERO WIDTH SPACE
    case 0x200c: // ZERO WIDTH NON-JOINER
    case 0x200e: // LEFT-TO-RIGHT MARK
    case 0x200f: // RIGHT-TO-LEFT MARK
    case 0x061c: // ARABIC LETTER MARK
    case 0x00ad: // SOFT HYPHEN
    case 0xfeff: // ZERO WIDTH NO-BREAK SPACE
    case 0x180e: // MONGOLIAN VOWEL SEPARATOR
    case 0xe0001: // TAG
      return true;
    default:
      break;
  }
  if (codePoint >= 0xe0020 && codePoint <= 0xe007f) return true; // unicode tags
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true; // BiDi controls
  if (codePoint >= 0x2066 && codePoint <= 0x2069) return true; // BiDi isolates
  if (codePoint >= 0x2060 && codePoint <= 0x2064) return true; // hidden modifiers
  return false;
}

function isVariationSelector(codePoint) {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isValidVariationSequence(base, selector) {
  if (isVariationSelector(base)) return false;
  const baseCharacter = String.fromCodePoint(base);
  if (!GRAPHIC.test(baseCharacter) || WHITESPACE.test(baseCharacter)) return false;
  if (selector >= 0xe0100) return HAN.test(baseCharacter);
  if (base < 0x80) {
    if (base !== 0x23 && base !== 0x2a && !(base >= 0x30 && base <= 0x39)) return false;
    return selector === 0xfe0e || selector === 0xfe0f;
  }
  return true;
}

/** `sanitize.Content` — strips invisible, bidirectional and tag characters. */
function sanitizeContent(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = '';
  let changed = false;
  let previous = '';
  let previousKept = false;
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    let keep = true;
    if (isVariationSelector(codePoint)) {
      keep = previousKept && previous !== '' && isValidVariationSequence(previous.codePointAt(0), codePoint);
    } else if (shouldRemoveRune(codePoint)) {
      keep = false;
    }
    previous = character;
    previousKept = keep;
    if (keep) out += character;
    else changed = true;
  }
  return changed ? out : input;
}

// ---------------------------------------------------------------------------
// Minimal projections (minimal_types.go)
// ---------------------------------------------------------------------------

/** `convertToMinimalWorkflowRun`. */
function convertToMinimalWorkflowRun(run) {
  if (!run) return undefined;

  const pullRequests = [];
  for (const pullRequest of asArray(run.pull_requests)) {
    if (pullRequest && (pullRequest.number ?? 0) !== 0) pullRequests.push(pullRequest.number);
  }

  const referencedWorkflows = [];
  for (const workflow of asArray(run.referenced_workflows)) {
    if (!workflow) continue;
    referencedWorkflows.push(
      defined({ path: workflow.path || undefined, sha: workflow.sha || undefined, ref: workflow.ref || undefined }),
    );
  }

  return defined({
    id: run.id ?? 0,
    name: run.name ?? '',
    display_title: run.display_title || undefined,
    workflow_id: run.workflow_id ?? 0,
    run_number: run.run_number ?? 0,
    run_attempt: run.run_attempt ?? 0,
    event: run.event || undefined,
    status: run.status ?? '',
    conclusion: run.conclusion || undefined,
    head_branch: run.head_branch || undefined,
    head_sha: run.head_sha || undefined,
    head_commit: run.head_commit?.message ? { message: sanitizeContent(run.head_commit.message) } : undefined,
    path: run.path || undefined,
    html_url: run.html_url || undefined,
    pull_requests: pullRequests.length > 0 ? pullRequests : undefined,
    actor: minimalUser(run.actor),
    triggering_actor: minimalUser(run.triggering_actor),
    referenced_workflows: referencedWorkflows.length > 0 ? referencedWorkflows : undefined,
    created_at: formatMinimalTimestamp(run.created_at) || undefined,
    updated_at: formatMinimalTimestamp(run.updated_at) || undefined,
    run_started_at: formatMinimalTimestamp(run.run_started_at) || undefined,
  });
}

/** `convertToMinimalWorkflowRuns` — `workflow_runs` is never omitted, even when empty. */
function convertToMinimalWorkflowRuns(runs) {
  const result = { total_count: 0, workflow_runs: [] };
  if (!runs) return result;
  result.total_count = runs.total_count ?? 0;
  for (const run of asArray(runs.workflow_runs)) {
    if (run) result.workflow_runs.push(convertToMinimalWorkflowRun(run));
  }
  return result;
}

/** `convertToMinimalWorkflowJobStep`. */
function convertToMinimalWorkflowJobStep(step) {
  return defined({
    name: step?.name ?? '',
    status: step?.status ?? '',
    conclusion: step?.conclusion || undefined,
    number: step?.number ?? 0,
    started_at: formatMinimalTimestamp(step?.started_at) || undefined,
    completed_at: formatMinimalTimestamp(step?.completed_at) || undefined,
  });
}

/** `convertToMinimalWorkflowJob`. */
function convertToMinimalWorkflowJob(job) {
  if (!job) return undefined;
  const steps = [];
  for (const step of asArray(job.steps)) {
    if (step) steps.push(convertToMinimalWorkflowJobStep(step));
  }
  const labels = asArray(job.labels).filter((label) => typeof label === 'string');
  return defined({
    id: job.id ?? 0,
    run_id: job.run_id ?? 0,
    name: job.name ?? '',
    workflow_name: job.workflow_name || undefined,
    status: job.status ?? '',
    conclusion: job.conclusion || undefined,
    head_branch: job.head_branch || undefined,
    head_sha: job.head_sha || undefined,
    html_url: job.html_url || undefined,
    run_attempt: job.run_attempt || undefined,
    runner_id: job.runner_id || undefined,
    runner_name: job.runner_name || undefined,
    runner_group_id: job.runner_group_id || undefined,
    runner_group_name: job.runner_group_name || undefined,
    labels: labels.length > 0 ? labels : undefined,
    steps: steps.length > 0 ? steps : undefined,
    created_at: formatMinimalTimestamp(job.created_at) || undefined,
    started_at: formatMinimalTimestamp(job.started_at) || undefined,
    completed_at: formatMinimalTimestamp(job.completed_at) || undefined,
  });
}

/** `convertToMinimalWorkflowJobs` — `jobs` is never omitted, even when empty. */
function convertToMinimalWorkflowJobs(jobs) {
  const result = { total_count: 0, jobs: [] };
  if (!jobs) return result;
  result.total_count = jobs.total_count ?? 0;
  for (const job of asArray(jobs.jobs)) {
    if (job) result.jobs.push(convertToMinimalWorkflowJob(job));
  }
  return result;
}

/** `convertToActionsWorkflow`. */
function convertToActionsWorkflow(workflow) {
  if (!workflow) return undefined;
  return defined({
    id: workflow.id,
    name: workflow.name,
    path: workflow.path,
    state: workflow.state,
    html_url: workflow.html_url,
    created_at: formatMinimalTimestamp(workflow.created_at) || undefined,
    updated_at: formatMinimalTimestamp(workflow.updated_at) || undefined,
  });
}

/** `convertToActionsWorkflows` — the inner `workflows` list is omitted when empty. */
function convertToActionsWorkflows(workflows) {
  if (!workflows) return undefined;
  const out = defined({ total_count: workflows.total_count });
  const items = [];
  for (const workflow of asArray(workflows.workflows)) items.push(convertToActionsWorkflow(workflow));
  if (items.length > 0) out.workflows = items;
  return out;
}

/** `convertToActionsArtifacts` — a nil entry is preserved as JSON `null`. */
function convertToActionsArtifacts(artifacts) {
  if (!artifacts) return undefined;
  const out = defined({ total_count: artifacts.total_count });
  const items = [];
  for (const artifact of asArray(artifacts.artifacts)) {
    if (!artifact) {
      items.push(null);
      continue;
    }
    items.push(
      defined({
        id: artifact.id,
        name: artifact.name,
        size_in_bytes: artifact.size_in_bytes,
        expired: artifact.expired,
        digest: artifact.digest,
        created_at: formatMinimalTimestamp(artifact.created_at) || undefined,
        updated_at: formatMinimalTimestamp(artifact.updated_at) || undefined,
        expires_at: formatMinimalTimestamp(artifact.expires_at) || undefined,
        workflow_run: artifact.workflow_run
          ? defined({
              id: artifact.workflow_run.id,
              head_branch: artifact.workflow_run.head_branch,
              head_sha: artifact.workflow_run.head_sha,
            })
          : undefined,
      }),
    );
  }
  if (items.length > 0) out.artifacts = items;
  return out;
}

/** `convertToActionsRunUsage` — `billable` is sorted by runner name. */
function convertToActionsRunUsage(usage) {
  if (!usage) return undefined;
  const billable = [];
  for (const [runner, bill] of Object.entries(usage.billable ?? {})) {
    const item = { runner };
    if (bill) {
      if (bill.total_ms !== undefined) item.total_ms = bill.total_ms;
      if (bill.jobs !== undefined) item.jobs = bill.jobs;
      const jobRuns = [];
      for (const jobRun of asArray(bill.job_runs)) {
        if (jobRun) jobRuns.push(defined({ job_id: jobRun.job_id, duration_ms: jobRun.duration_ms }));
      }
      if (jobRuns.length > 0) item.job_runs = jobRuns;
    }
    billable.push(item);
  }
  billable.sort((a, b) => (a.runner < b.runner ? -1 : a.runner > b.runner ? 1 : 0));
  const out = {};
  if (billable.length > 0) out.billable = billable;
  if (usage.run_duration_ms !== undefined) out.run_duration_ms = usage.run_duration_ms;
  return out;
}

// ---------------------------------------------------------------------------
// Method helpers
// ---------------------------------------------------------------------------

/** The `{owner}/{repo}/actions/workflows/<ref>` path segment for an ID or a file name. */
function workflowRef(resourceId) {
  return parseGoInt(resourceId) !== null ? String(resourceId) : pathSeg(resourceId);
}

/** `ActionsWorkflowRunsFilter` / `ActionsWorkflowJobsFilter` decoding. */
function decodeFilter(args, key) {
  const raw = args?.[key];
  if (raw === undefined) return { value: {}, validationError: '' };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      value: {},
      validationError: `parameter ${key} is not of type map[string]interface {}, is ${goTypeName(raw)}`,
    };
  }
  const value = {};
  for (const [name, entry] of Object.entries(raw)) value[name] = typeof entry === 'string' ? entry : '';
  return { value, validationError: '' };
}

// ---------------------------------------------------------------------------
// actions_list
// ---------------------------------------------------------------------------

/** `actions_list` — list workflows, workflow runs, jobs or run artifacts. */
async function actionsList(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const method = requireString(args, 'method');
  const resourceId = optionalString(args, 'resource_id') ?? '';
  const { page, per_page } = paginationQuery(args, { defaultPerPage: 30 });
  const base = `/repos/${seg(owner)}/${seg(repo)}/actions`;

  let resourceIdInt = 0;
  switch (method) {
    case 'list_workflows':
    case 'list_workflow_runs':
      // No resource ID needed; for list_workflow_runs it is optional.
      break;
    default:
      if (resourceId === '') fail(`missing required parameter for method ${method}: resource_id`);
      resourceIdInt = parseGoInt(resourceId);
      if (resourceIdInt === null) fail(`invalid resource_id, must be an integer for method ${method}: ${parseIntError(resourceId)}`);
  }

  switch (method) {
    case 'list_workflows': {
      const workflows = await ctx.client.get(`${base}/workflows`, { query: { page, per_page }, signal: ctx.signal });
      return { method, workflows: convertToActionsWorkflows(workflows) };
    }
    case 'list_workflow_runs': {
      const filter = decodeFilter(args, 'workflow_runs_filter');
      if (filter.validationError !== '') fail(filter.validationError);
      const path = resourceId === '' ? `${base}/runs` : `${base}/workflows/${workflowRef(resourceId)}/runs`;
      const runs = await ctx.client.get(path, {
        query: {
          actor: filter.value.actor,
          branch: filter.value.branch,
          event: filter.value.event,
          status: filter.value.status,
          page,
          per_page,
        },
        signal: ctx.signal,
      });
      return { method, workflow_runs: convertToMinimalWorkflowRuns(runs) };
    }
    case 'list_workflow_jobs': {
      const filter = decodeFilter(args, 'workflow_jobs_filter');
      if (filter.validationError !== '') fail(filter.validationError);
      const jobs = await ctx.client.get(`${base}/runs/${resourceIdInt}/jobs`, {
        query: { filter: filter.value.filter, page, per_page },
        signal: ctx.signal,
      });
      return { method, workflow_jobs: convertToMinimalWorkflowJobs(jobs) };
    }
    case 'list_workflow_run_artifacts': {
      const artifacts = await ctx.client.get(`${base}/runs/${resourceIdInt}/artifacts`, {
        query: { page, per_page },
        signal: ctx.signal,
      });
      return { method, artifacts: convertToActionsArtifacts(artifacts) };
    }
    default:
      return fail(`unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// actions_get
// ---------------------------------------------------------------------------

/** `actions_get` — a workflow, run, job, usage, artifact link or run-logs link. */
async function actionsGet(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const method = requireString(args, 'method');
  const resourceId = requireString(args, 'resource_id');
  const base = `/repos/${seg(owner)}/${seg(repo)}/actions`;

  let resourceIdInt = 0;
  if (method !== 'get_workflow') {
    resourceIdInt = parseGoInt(resourceId);
    if (resourceIdInt === null) fail(`invalid resource_id, must be an integer for method ${method}: ${parseIntError(resourceId)}`);
  }

  switch (method) {
    case 'get_workflow': {
      const workflow = await ctx.client.get(`${base}/workflows/${workflowRef(resourceId)}`, { signal: ctx.signal });
      return { method, workflow: convertToActionsWorkflow(workflow) };
    }
    case 'get_workflow_run': {
      const run = await ctx.client.get(`${base}/runs/${resourceIdInt}`, { signal: ctx.signal });
      return { method, workflow_run: convertToMinimalWorkflowRun(run) };
    }
    case 'get_workflow_job': {
      const job = await ctx.client.get(`${base}/jobs/${resourceIdInt}`, { signal: ctx.signal });
      return defined({ method, workflow_job: convertToMinimalWorkflowJob(job) });
    }
    case 'get_workflow_run_usage': {
      const usage = await ctx.client.get(`${base}/runs/${resourceIdInt}/timing`, { signal: ctx.signal });
      return { method, usage: convertToActionsRunUsage(usage) };
    }
    case 'download_workflow_run_artifact': {
      // NOTE: upstream returns the `Location` of the 302 that
      // `GET .../actions/artifacts/{id}/zip` responds with. The shared client
      // follows redirects transparently and never exposes response headers, so
      // the pre-signed URL cannot be observed without downloading the archive;
      // return the authenticated API endpoint that performs the redirect.
      return {
        method,
        artifact: {
          artifact_id: resourceIdInt,
          download_url: ctx.client.restUrl(`${base}/artifacts/${resourceIdInt}/zip`),
          message: 'Artifact is available for download',
          note: NOTE_ARTIFACT_DOWNLOAD,
        },
      };
    }
    case 'get_workflow_run_logs_url': {
      // NOTE: upstream returns the `Location` of the 302 that
      // `GET .../actions/runs/{run_id}/logs` responds with. The shared client
      // follows redirects transparently and never exposes response headers, so
      // the pre-signed URL cannot be observed without downloading the whole ZIP;
      // return the authenticated API endpoint that performs the redirect.
      return {
        method,
        logs: {
          logs_url: ctx.client.restUrl(`${base}/runs/${resourceIdInt}/logs`),
          message: 'Workflow run logs are available for download',
          note: NOTE_RUN_LOGS,
          optimization_tip: `Use: get_job_logs with parameters {run_id: ${resourceIdInt}, failed_only: true} for more efficient failed job debugging`,
          warning: WARNING_RUN_LOGS,
        },
      };
    }
    default:
      return fail(`unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// actions_run_trigger
// ---------------------------------------------------------------------------

/** `actions_run_trigger` — dispatch, re-run, cancel runs and delete run logs. */
async function actionsRunTrigger(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const method = requireString(args, 'method');
  const workflowId = optionalString(args, 'workflow_id') ?? '';
  const ref = optionalString(args, 'ref') ?? '';
  const runId = toPositiveInt(args.run_id, 0);
  const base = `/repos/${seg(owner)}/${seg(repo)}/actions`;

  if (method === 'run_workflow') {
    if (workflowId === '') fail('workflow_id is required for run_workflow action');
    if (ref === '') fail('ref is required for run_workflow action');
  } else if (runId === 0) {
    fail('missing required parameter: run_id');
  }

  /** The shared `{method, <key>: {message, run_id, status, status_code}}` shape. */
  const operation = async (path, key, message) => {
    const { response } = await ctx.client.request('POST', path, { signal: ctx.signal });
    return { method, [key]: { message, run_id: runId, status: statusLine(response), status_code: response.status } };
  };

  switch (method) {
    case 'run_workflow': {
      const raw = args.inputs;
      const inputs = raw !== undefined && raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : null;
      const byId = parseGoInt(workflowId) !== null;
      const body = { ref };
      // go-github's CreateWorkflowDispatchEventRequest omits `inputs` when empty.
      if (inputs && Object.keys(inputs).length > 0) body.inputs = inputs;
      const { response } = await ctx.client.request(
        'POST',
        `${base}/workflows/${byId ? workflowId : pathSeg(workflowId)}/dispatches`,
        { body, signal: ctx.signal },
      );
      return {
        method,
        dispatch: {
          inputs,
          message: 'Workflow run has been queued',
          ref,
          status: statusLine(response),
          status_code: response.status,
          workflow_id: workflowId,
          workflow_type: byId ? 'workflow_id' : 'workflow_file',
        },
      };
    }
    case 'rerun_workflow_run':
      return operation(`${base}/runs/${runId}/rerun`, 'rerun', 'Workflow run has been queued for re-run');
    case 'rerun_failed_jobs':
      return operation(`${base}/runs/${runId}/rerun-failed-jobs`, 'rerun_failed', 'Failed jobs have been queued for re-run');
    case 'cancel_workflow_run':
      // go-github surfaces 202 as an AcceptedError, which the upstream handler ignores.
      return operation(`${base}/runs/${runId}/cancel`, 'cancel', 'Workflow run has been cancelled');
    case 'delete_workflow_run_logs':
      return operation(`${base}/runs/${runId}/logs`, 'delete_logs', 'Workflow run logs have been deleted');
    default:
      return fail(`unknown method: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// get_job_logs
// ---------------------------------------------------------------------------

/** Split a log body the way the upstream ring buffer counts lines. */
function splitLogLines(text) {
  const lines = String(text ?? '').split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** buffer.go truncates over-long lines to 1000 characters plus a suffix. */
function truncateLogLine(line) {
  if (line.length <= MAX_LINE_SIZE) return line;
  return `${line.slice(0, 1000)}${TRUNCATED_SUFFIX}`;
}

/** `getJobLogData` — the job-log URL, or the tail of the downloaded log. */
async function jobLogData(ctx, owner, repo, jobId, jobName, returnContent, tailLines) {
  const path = `/repos/${seg(owner)}/${seg(repo)}/actions/jobs/${jobId}/logs`;
  const named = jobName ? { job_name: jobName } : {};

  if (!returnContent) {
    // NOTE: upstream returns the `Location` of the 302 that this endpoint
    // responds with. The shared client follows redirects transparently and never
    // exposes response headers, so return the API endpoint that redirects.
    return {
      job_id: jobId,
      ...named,
      logs_url: ctx.client.restUrl(path),
      message: 'Job logs are available for download',
      note: NOTE_JOB_LOGS_URL,
    };
  }

  // The client follows the 302 to the pre-signed plain-text log.
  const text = await ctx.client.getText(path, { signal: ctx.signal });
  const lines = splitLogLines(text);
  const window = Math.max(1, Math.min(tailLines, CONTENT_WINDOW_SIZE));
  const kept = lines.slice(Math.max(0, lines.length - window)).map(truncateLogLine);
  return {
    job_id: jobId,
    ...named,
    logs_content: kept.join('\n'),
    message: 'Job logs content retrieved successfully',
    original_length: lines.length,
  };
}

/** `handleFailedJobLogs` — the logs of every failed job of a run. */
async function handleFailedJobLogs(ctx, owner, repo, runId, returnContent, tailLines) {
  const jobs = await ctx.client.get(`/repos/${seg(owner)}/${seg(repo)}/actions/runs/${runId}/jobs`, {
    query: { filter: 'latest' },
    signal: ctx.signal,
  });
  const all = asArray(jobs?.jobs);
  const failed = all.filter((job) => job?.conclusion === 'failure');

  if (failed.length === 0) {
    return { message: 'No failed jobs found in this workflow run', run_id: runId, total_jobs: all.length };
  }

  const logs = [];
  for (const job of failed) {
    try {
      logs.push(await jobLogData(ctx, owner, repo, job.id, job.name, returnContent, tailLines));
    } catch (error) {
      // One job's failure never fails the whole call (upstream behaviour).
      logs.push({ error: error?.message ?? String(error), job_id: job.id, job_name: job.name });
    }
  }

  return {
    failed_jobs: failed.length,
    logs,
    message: `Retrieved logs for ${failed.length} failed jobs`,
    return_format: { content: returnContent, urls: !returnContent },
    run_id: runId,
    total_jobs: all.length,
  };
}

/** `get_job_logs` — one job's log content/URL, or the failed jobs of a run. */
async function getJobLogs(args, ctx) {
  const owner = requireString(args, 'owner');
  const repo = requireString(args, 'repo');
  const jobId = toPositiveInt(args.job_id, 0);
  const runId = toPositiveInt(args.run_id, 0);
  const failedOnly = optionalBoolean(args, 'failed_only', false) === true;
  const returnContent = optionalBoolean(args, 'return_content', false) === true;
  const tailLines = toPositiveInt(args.tail_lines, DEFAULT_TAIL_LINES);

  if (failedOnly && runId === 0) fail('run_id is required when failed_only is true');
  if (!failedOnly && jobId === 0) fail('job_id is required when failed_only is false');

  if (failedOnly && runId > 0) return handleFailedJobLogs(ctx, owner, repo, runId, returnContent, tailLines);
  if (jobId > 0) return jobLogData(ctx, owner, repo, jobId, '', returnContent, tailLines);
  return fail('Either job_id must be provided for single job logs, or run_id with failed_only=true for failed job logs');
}

export default {
  actions_get: actionsGet,
  actions_list: actionsList,
  actions_run_trigger: actionsRunTrigger,
  get_job_logs: getJobLogs,
};

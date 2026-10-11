/**
 * dsh-github-tools — the GitHub tool set as a native DSH (Cordis) Host plugin.
 *
 * A reimplementation of the tools exposed by `github/github-mcp-server` as
 * first-class harness tools instead of an MCP server: every tool is registered
 * through the host `tools` service, so there is no child process, no transport,
 * and no MCP client in the loop. Tools are plain HTTP calls against the GitHub
 * REST and GraphQL APIs.
 *
 * The tool inventory (names, descriptions, parameter and output schemas) is
 * generated from the upstream repository's `__toolsnaps__`, which serialize
 * exactly what the Go server advertises; the handlers under `handlers/` are the
 * port of the upstream implementations.
 *
 * @module dsh-github-tools
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { GitHubClient } from './client.js';
import { definitions, toolsets } from './generated/data.js';
import { duplicateHandlers, handlerSources, handlers } from './handlers/index.js';
import { renderOutput } from './render.js';
import { toToolParameters } from './schema.js';
import { selectTools } from './select.js';

/** Services this plugin registers into. */
export const inject = ['tools'];

/** Plugin configuration. */
export const Config = z.object({
  /** GitHub personal access token (or GitHub App installation token). */
  token: z.string(),
  /** Environment variable consulted when `token` is not set. */
  tokenEnv: z.string().default('GITHUB_PERSONAL_ACCESS_TOKEN'),
  /** `github.com`, or the hostname of a GitHub Enterprise Server instance. */
  host: z.string().default('github.com'),
  /** Override the REST base URL (defaults to the value derived from `host`). */
  apiBaseUrl: z.string(),
  /** Override the GraphQL endpoint (defaults to the value derived from `host`). */
  graphqlUrl: z.string(),
  /** Toolsets to enable; omitted means the upstream default set, `['all']` means everything. */
  toolsets: z.array(z.string()),
  /** Explicit tool names; when non-empty this replaces `toolsets` entirely. */
  tools: z.array(z.string()),
  /** Tool names to remove from the selection. */
  excludeTools: z.array(z.string()),
  /** Register only the tools the upstream server marks read-only. */
  readOnly: z.boolean().default(false),
  /** Ask the harness to defer loading the definitions until first use. */
  deferLoading: z.boolean().default(false),
  /** Per-call HTTP timeout in milliseconds. */
  timeoutMs: z.number().default(60_000),
  /** Retries for 429/5xx responses. */
  retries: z.number().default(2),
  /** User-Agent header sent to GitHub. */
  userAgent: z.string(),
  /** Upper bound on items collected by a single paginated call. */
  maxItems: z.number().default(1_000),
});

const DEFAULTS = {
  tokenEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  host: 'github.com',
  readOnly: false,
  deferLoading: false,
  timeoutMs: 60_000,
  retries: 2,
  maxItems: 1_000,
};

/** Environment variables consulted, in order, when no token is configured. */
const TOKEN_ENV_FALLBACKS = ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'];

function resolveToken(config, env) {
  if (typeof config.token === 'string' && config.token.length > 0) return config.token;
  const names = [config.tokenEnv, ...TOKEN_ENV_FALLBACKS].filter((name) => typeof name === 'string' && name.length > 0);
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** A logger that degrades to a no-op when the context offers none. */
function makeLogger(ctx) {
  let logger;
  try {
    logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-github-tools') : undefined;
  } catch {
    logger = undefined;
  }
  return (level, message) => {
    try {
      const method = logger?.[level];
      if (typeof method === 'function') method.call(logger, message);
      else if (level === 'error') console.error(`[dsh-github-tools] ${message}`);
    } catch {
      /* logging must never break tool registration */
    }
  };
}

/**
 * Build the harness tool definition for one generated tool.
 *
 * `output.schema` is intentionally the permissive `{type: 'object', additionalProperties: true}`:
 * the upstream output schemas use `$ref`/`$defs`/`anyOf`, none of which the author
 * schema DSL supports, and the rendered text block (not the structured schema) is
 * what the model sees. Every handler therefore returns a JSON object.
 */
function buildTool(definition, handler, context) {
  const readOnly = definition.annotations?.readOnlyHint === true;
  const parameters = toToolParameters(definition.inputSchema);
  const tool = {
    name: definition.name,
    description: definition.description,
    parameters,
    timeoutMs: context.config.timeoutMs,
    isConcurrencySafe: () => readOnly,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: renderOutput,
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted === true) {
        const error = new Error('tool call aborted');
        error.name = 'AbortError';
        throw error;
      }
      return handler(args ?? {}, {
        client: context.client,
        config: context.config,
        log: context.log,
        signal: exec?.signal,
      });
    },
  };
  if (context.config.deferLoading === true) tool.deferLoading = true;
  return defineTool(tool);
}

/**
 * Register the selected GitHub tools.
 *
 * @param {object} ctx   the Cordis plugin context
 * @param {object} [config] the plugin row's `config:` block
 */
export function apply(ctx, config) {
  const log = makeLogger(ctx);
  const tools = ctx.get('tools');
  if (tools === undefined || typeof tools.register !== 'function') {
    log('error', 'the host `tools` service is unavailable; no GitHub tools were registered');
    return;
  }

  const resolved = { ...DEFAULTS, ...(config ?? {}) };
  const token = resolveToken(resolved, process.env);
  const client = new GitHubClient({
    token,
    host: resolved.host,
    apiBaseUrl: resolved.apiBaseUrl,
    graphqlUrl: resolved.graphqlUrl,
    timeoutMs: resolved.timeoutMs,
    retries: resolved.retries,
    userAgent: resolved.userAgent,
    log: (message) => log('debug', message),
  });

  const selection = selectTools({ definitions, toolsets, config: resolved });
  const context = { client, config: resolved, log: (message) => log('debug', message) };

  const skipped = [];
  const failed = [];
  let registered = 0;
  for (const definition of selection.selected) {
    const handler = handlers[definition.name];
    if (typeof handler !== 'function') {
      skipped.push(definition.name);
      continue;
    }
    try {
      tools.register(buildTool(definition, handler, context));
      registered += 1;
    } catch (error) {
      failed.push(`${definition.name}: ${error?.message ?? error}`);
    }
  }

  for (const entry of duplicateHandlers) {
    log('error', `duplicate handler for ${entry.name} in ${entry.files.join(', ')}; using ${entry.files[0]}`);
  }
  if (selection.unknownToolsets.length > 0) log('error', `unknown toolsets ignored: ${selection.unknownToolsets.join(', ')}`);
  if (selection.unknownTools.length > 0) log('error', `unknown tools ignored: ${selection.unknownTools.join(', ')}`);
  if (skipped.length > 0) log('error', `no handler implemented for: ${skipped.join(', ')}`);
  for (const failure of failed) log('error', `failed to register ${failure}`);
  if (token === null) {
    log(
      'error',
      `no GitHub token configured: set the plugin's token, or export ${resolved.tokenEnv} (also checked: ${TOKEN_ENV_FALLBACKS.join(', ')}). Calls will fail with HTTP 401.`,
    );
  }

  log(
    'info',
    `registered ${registered}/${selection.selected.length} GitHub tools ` +
      `(toolsets: ${selection.enabledToolsets.join(', ')}${resolved.readOnly ? '; read-only' : ''})`,
  );
}

export default apply;

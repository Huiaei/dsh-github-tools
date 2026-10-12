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

/**
 * Plugin configuration.
 *
 * EVERY field is `.volatile()`, and that is not decoration: DSH's settings service
 * projects a plugin's config into an editable form only through `volatileForm()`,
 * which keeps a field only when its nearest ancestor is marked volatile. A schema
 * without one is never served as a settings namespace, so `configForms.get()` never
 * resolves, `whileServed()` never fires and the configuration page waits forever.
 * A volatile field must not sit inside another volatile one, so every leaf here is
 * marked directly and no object node is.
 */
export const Config = z.object({
  /** GitHub personal access token (or GitHub App installation token). */
  token: z.string().default('').volatile(),
  /** Environment variable consulted when `token` is not set. */
  tokenEnv: z.string().default('GITHUB_PERSONAL_ACCESS_TOKEN').volatile(),
  /** `github.com`, or the hostname of a GitHub Enterprise Server instance. */
  host: z.string().default('github.com').volatile(),
  /** Override the REST base URL (defaults to the value derived from `host`). */
  apiBaseUrl: z.string().default('').volatile(),
  /** Override the GraphQL endpoint (defaults to the value derived from `host`). */
  graphqlUrl: z.string().default('').volatile(),
  /** Toolsets to enable; `[]`/omitted means the upstream default set, `['all']` means everything. */
  toolsets: z.array(z.string()).default(['default']).volatile(),
  /** Explicit tool names; when non-empty this replaces `toolsets` entirely. */
  tools: z.array(z.string()).default([]).volatile(),
  /** Tool names to remove from the selection. */
  excludeTools: z.array(z.string()).default([]).volatile(),
  /** Register only the tools the upstream server marks read-only. */
  readOnly: z.boolean().default(false).volatile(),
  /** Ask the harness to defer loading the definitions until first use. */
  deferLoading: z.boolean().default(false).volatile(),
  /** Per-call HTTP timeout in milliseconds. */
  timeoutMs: z.number().default(60_000).volatile(),
  /** Retries for 429/5xx responses. */
  retries: z.number().default(2).volatile(),
  /** User-Agent header sent to GitHub. */
  userAgent: z.string().default('dsh-github-tools').volatile(),
  /** Upper bound on items collected by a single paginated call. */
  maxItems: z.number().default(1_000).volatile(),
});

/** Every configuration key, with the same default the schema declares. */
const DEFAULTS = {
  token: '',
  tokenEnv: 'GITHUB_PERSONAL_ACCESS_TOKEN',
  host: 'github.com',
  apiBaseUrl: '',
  graphqlUrl: '',
  toolsets: ['default'],
  tools: [],
  excludeTools: [],
  readOnly: false,
  deferLoading: false,
  timeoutMs: 60_000,
  retries: 2,
  userAgent: 'dsh-github-tools',
  maxItems: 1_000,
};

/**
 * Read one configuration value, unwrapping a volatile cell.
 *
 * A `.volatile()` schema field does NOT resolve to its value: schemastery wraps it
 * with cosmokit's `createVolatile(default)`, which is why the shipped plugins read
 * theirs as `config.timeoutMs.get()`. The cell is written in place when the user
 * edits the field — that in-place write is what makes an edit apply without
 * remounting the plugin — so reading through `.get()` is both required for
 * correctness and how live updates arrive. A plain value (an older host, or a
 * hand-built settings object in a test) passes through untouched.
 */
function unbox(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/** The plugin's configuration as plain values, resolved at call time. */
function readConfig(raw) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = unbox(raw?.[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

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
 * `output.schema` is intentionally the permissive `{type: 'json'}` (it compiles to an
 * unconstrained schema): the upstream output schemas use `$ref`/`$defs`/`anyOf`, none of
 * which the author schema DSL supports, and upstream tools return a mix of objects,
 * arrays and plain strings. The rendered text block (not the structured schema) is
 * what the model sees, so a handler may return any JSON value.
 */
function buildTool(definition, handler, state) {
  const readOnly = definition.annotations?.readOnlyHint === true;
  const parameters = toToolParameters(definition.inputSchema);
  const tool = {
    name: definition.name,
    description: definition.description,
    parameters,
    timeoutMs: readConfig(state.raw).timeoutMs,
    isConcurrencySafe: () => readOnly,
    output: {
      schema: { type: 'json' },
      render: renderOutput,
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted === true) {
        const error = new Error('tool call aborted');
        error.name = 'AbortError';
        throw error;
      }
      // Resolve the configuration per call: a volatile field is a live cell that
      // the settings service writes in place, so `.get()` here is what makes an
      // edit apply without remounting the plugin.
      return handler(args ?? {}, {
        client: state.client,
        config: readConfig(state.raw),
        log: state.log,
        signal: exec?.signal,
      });
    },
  };
  if (readConfig(state.raw).deferLoading === true) tool.deferLoading = true;
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

  // A volatile settings edit is written into the same object the loader handed us
  // and then announced, so the resolved values are re-read from `state.raw` at call
  // time (`loader/volatile-update` below re-syncs the tool set). Registering a tool
  // is likewise a live operation — `register` returns its own disposer — so a
  // toolset or read-only change is not restart-only.
  const state = {
    raw: config ?? {},
    client: null,
    log: (message) => log('debug', message),
  };

  const buildClient = (resolved) => new GitHubClient({
    token: resolveToken(resolved, process.env),
    host: resolved.host,
    apiBaseUrl: resolved.apiBaseUrl,
    graphqlUrl: resolved.graphqlUrl,
    timeoutMs: resolved.timeoutMs,
    retries: resolved.retries,
    userAgent: resolved.userAgent,
    log: state.log,
  });

  /** name -> disposer for the tools this plugin currently has mounted. */
  const mounted = new Map();

  /** Re-resolve the configuration and diff the mounted tools against it. */
  const sync = () => {
    const resolved = readConfig(state.raw);
    state.client = buildClient(resolved);
    const selection = selectTools({ definitions, toolsets, config: resolved });
    const wanted = new Set();
    const skipped = [];
    for (const definition of selection.selected) {
      const handler = handlers[definition.name];
      if (typeof handler !== 'function') {
        skipped.push(definition.name);
        continue;
      }
      wanted.add(definition.name);
      if (mounted.has(definition.name)) continue;
      try {
        mounted.set(definition.name, tools.register(buildTool(definition, handler, state)));
      } catch (error) {
        log('error', `failed to register ${definition.name}: ${error?.message ?? error}`);
      }
    }
    for (const [name, dispose] of [...mounted]) {
      if (wanted.has(name)) continue;
      mounted.delete(name);
      try {
        dispose();
      } catch (error) {
        log('error', `failed to unregister ${name}: ${error?.message ?? error}`);
      }
    }

    for (const entry of duplicateHandlers) {
      log('error', `duplicate handler for ${entry.name} in ${entry.files.join(', ')}; using ${entry.files[0]}`);
    }
    if (selection.unknownToolsets.length > 0) log('error', `unknown toolsets ignored: ${selection.unknownToolsets.join(', ')}`);
    if (selection.unknownTools.length > 0) log('error', `unknown tools ignored: ${selection.unknownTools.join(', ')}`);
    if (skipped.length > 0) log('error', `no handler implemented for: ${skipped.join(', ')}`);
    if (state.client.authenticated !== true) {
      log(
        'error',
        `no GitHub token configured: set the plugin's token, or export ${resolved.tokenEnv} (also checked: ${TOKEN_ENV_FALLBACKS.join(', ')}). Calls will fail with HTTP 401.`,
      );
    }
    log(
      'info',
      `registered ${mounted.size}/${selection.selected.length} GitHub tools ` +
        `(toolsets: ${selection.enabledToolsets.join(', ')}${resolved.readOnly ? '; read-only' : ''})`,
    );
  };

  sync();

  // A volatile edit writes the field's cell in place and then announces it, so the
  // new value is already visible to `readConfig`; re-syncing is what diffs the
  // mounted tools against the new toolset / read-only selection.
  if (typeof ctx.on === 'function') {
    ctx.on('loader/volatile-update', () => {
      try {
        sync();
      } catch (error) {
        log('error', `applying a live settings change failed: ${error?.message ?? error}`);
      }
    });
  }
}

/*
 * NOTE: deliberately NO `export default`.
 *
 * The Cordis loader resolves a plugin with
 *   unwrapExports(exports) { exports = exports.default ?? exports; if (!exports.__esModule) return exports; ... }
 * so a `default` export replaces the whole module with that value. Exporting `apply` as
 * default makes the plugin object the bare function, `plugin.Config` becomes undefined, and
 * the harness reports the row as `status: "absent"` — the plugin then has no settings schema
 * and no config form in the UI. Exporting only named bindings keeps the module namespace as
 * the plugin object, where `apply`, `inject`, `name` and `Config` are all visible.
 */

# dsh-github-tools

The complete [github-mcp-server](https://github.com/github/github-mcp-server) tool set —
**131 GitHub tools** — reimplemented as **native DeepSeek Harness (Cordis) tools**.

No MCP server, no child process, no transport, no `mcp__github__*` name prefix: every tool is
registered directly on the harness `tools` service and calls the GitHub REST and GraphQL APIs
over plain `fetch`.

```
GitHub REST / GraphQL  ←  src/client.js  ←  src/handlers/*.js  ←  ctx.tools.register  ←  DSH
```

## Why not just run the MCP server?

| | MCP stdio server | Remote MCP (HTTP) | **this plugin** |
| --- | --- | --- | --- |
| Process model | resident child process, one per session | none local | none — plain in-process modules |
| Start-up cost | probe process + handshake on every activation | network round trip per call | none |
| Failure mode | a crashed child consumes the reconnect budget | remote availability | an ordinary in-process exception |
| Tool names | `mcp__github__<tool>` | `mcp__github__<tool>` | `<tool>` (e.g. `issue_read`) |
| Auth | env var handed to the child | GitHub-hosted OAuth | the plugin config or `GITHUB_PERSONAL_ACCESS_TOKEN` |
| Cost of a new tool | rebuild the Go binary / wait for upstream | not under your control | add a handler function |

The tool inventory (names, descriptions, parameter schemas, read-only annotations) is **generated
from the upstream repository's `__toolsnaps__`**, so the surface the model sees matches the Go
server. The handlers are a port of the upstream Go implementations.

## Install

```bash
# from a local checkout
dsh plugin add /path/to/dsh-github-tools

# or via the plugin manager tools: list_bundles → install_bundle
```

The bundle patch (`cordis.patch.yml`) inserts one process-wide row, so every agent preset gets
the tools without declaring anything. Override that row by id (`- id: github-tools` with
`disabled: true`) in a later patch layer to keep them out of a composition.

### Token

Set `GITHUB_PERSONAL_ACCESS_TOKEN` (also checked: `GITHUB_TOKEN`, `GH_TOKEN`), or put the token
in the plugin row's `config.token`. Without a token the plugin still registers, but every call
fails with HTTP 401.

## Configuration

| key | type | default | meaning |
| --- | --- | --- | --- |
| `token` | string | `''` | PAT or GitHub App installation token |
| `tokenEnv` | string | `GITHUB_PERSONAL_ACCESS_TOKEN` | env var consulted first when `token` is empty |
| `host` | string | `github.com` | `github.com`, or a GitHub Enterprise Server hostname |
| `apiBaseUrl` | string | derived | override the REST base (`https://api.github.com`, `https://<host>/api/v3`) |
| `graphqlUrl` | string | derived | override the GraphQL endpoint |
| `toolsets` | string[] | `['default']` | toolsets to enable; `['all']` enables all 131; `['default']` is the upstream default set |
| `tools` | string[] | `[]` | explicit tool names; when non-empty this **replaces** `toolsets` |
| `excludeTools` | string[] | `[]` | tool names removed from the selection (applied last) |
| `readOnly` | boolean | `false` | register only tools the upstream marks `readOnlyHint: true` |
| `deferLoading` | boolean | `false` | ask the harness to defer loading the definitions until first use |
| `timeoutMs` | number | `60000` | per-call HTTP timeout |
| `retries` | number | `2` | retries for `429`/`5xx` (honours `Retry-After`) |
| `userAgent` | string | `dsh-github-tools/1.0.0` | `User-Agent` header |
| `maxItems` | number | `1000` | upper bound on items collected by one paginated call |

The default set (the upstream `default: true` toolsets) is `context`, `repos`, `issues`,
`pull_requests`, `users`, `copilot` — 86 tools. `toolsets: ['all']` registers all 131.

## Tools

| toolset | tools | default | upstream description |
| --- | ---: | :---: | --- |
| `context` | 4 | yes | tools that provide context about the current user and GitHub context |
| `repos` | 21 | yes | repository related tools |
| `git` | 1 | — | low-level Git operations |
| `issues` | 31 | yes | issue related tools |
| `pull_requests` | 27 | yes | pull request related tools |
| `users` | 1 | yes | user search |
| `orgs` | 1 | — | organization search |
| `governance` | 4 | — | rulesets and custom properties |
| `actions` | 4 | — | Actions workflows and CI/CD |
| `code_quality` | 1 | — | Code Quality findings |
| `code_security` | 2 | — | code scanning alerts |
| `secret_protection` | 2 | — | secret scanning alerts |
| `dependabot` | 2 | — | Dependabot alerts |
| `notifications` | 6 | — | notification management |
| `discussions` | 5 | — | discussions |
| `gists` | 4 | — | gists |
| `security_advisories` | 4 | — | global and repository security advisories |
| `projects` | 3 | — | Projects v2 |
| `stargazers` | 3 | — | starring repositories |
| `labels` | 2 | — | label reads and writes |
| `copilot` | 2 | yes | Copilot assignment and review |
| `copilot_issue_intents` | 1 | — | opt-in Copilot assignment with intent metadata |

`all`, `default`, `copilot_spaces` and `github_support_docs_search` are meta/empty toolsets: they
select other toolsets or currently expose no tools upstream.

## How it works

```
src/
  index.js            the Cordis plugin: Config, inject, apply(), tool registration
  client.js           GitHubClient — REST/GraphQL, Link pagination, retries, typed errors
  schema.js           upstream JSON Schema → the harness's supported schema dialect
  select.js           toolset / tools / excludeTools / readOnly resolution
  render.js           handler result → the text content block the model sees
  util.js             shared argument and response helpers
  generated/
    tools.json        131 tool definitions, extracted from the upstream __toolsnaps__
    toolsets.json     26 toolset definitions
    data.js           loads both
  handlers/
    index.js          merges the 14 handler modules, reports duplicates
    context.js        get_me, get_teams, get_team_members, ui_get, search_users, search_orgs
    repos.js  issues.js  issues_granular.js  pull_requests.js  pr_granular.js
    actions.js  security.js  governance.js  notifications.js  discussions.js
    gists.js  labels.js  copilot.js
```

Every handler is `async (args, ctx) => plainObject`; `ctx` carries `client`, `config`, `log` and
`signal`. Registration, schemas, timeouts and rendering live in `src/index.js`, so a handler never
touches the harness. See [`docs/HANDLER-CONTRACT.md`](docs/HANDLER-CONTRACT.md).

## Development

```bash
node scripts/generate.mjs   # regenerate src/generated/* from a github-mcp-server checkout
node scripts/verify.mjs     # inventory + schema-dialect + handler-coverage check
node --test tests/          # unit tests
```

`scripts/generate.mjs` reads `pkg/github/__toolsnaps__/*.snap` and the Go sources from a
github-mcp-server checkout (default `/tmp/gh-mcp`, override with `--source <dir>`); it maps every
tool to its toolset, source file and source function.

The test suite includes a local reimplementation of the harness JSON-Schema validator, so the
generated schemas are checked against the real dialect without the harness installed.

## Fidelity and limitations

- **Inventory**: 1:1 with the upstream `__toolsnaps__` (141 snapshots → 131 unique tools; the
  extras are `*_output` schema snapshots and feature-flag variants of the same tool).
- **Schemas**: normalized to the harness dialect — `anyOf`/`$ref`/`$defs`/`minimum`/`maximum`/
  `minLength`/`x-mcp-header` are not expressible there and are dropped; the constraint keywords
  that remain (`type`, `oneOf`, `properties`, `required`, `items`, `enum`, `const`) are preserved.
- **Output**: the upstream `outputSchema` is not enforced — the plugin declares
  `output.schema = {type: 'json'}`. Handlers return JSON values (objects, plus arrays or raw
  strings where the upstream tool does), which are rendered as an indented text block; that is
  what the model reads anyway.
- **Scopes**: the plugin does not pre-check token scopes; GitHub returns the usual 403/404.
- **Write tools**: exactly as in the upstream server, write tools perform real changes. Use
  `readOnly: true` or `excludeTools` to restrict a session.

### Deviations

Every tool call reaches the same endpoint with the same parameters as upstream. The differences
are in the shape of the *rendered result*, and each one is deliberate:

| Deviation | Where | Why |
| --- | --- | --- |
| A list result is wrapped as `{items: [...], page, per_page}` — or `{directory: [...]}` for a directory listing — instead of upstream's bare array | the list tools in `repos.js`, `issues.js`, `pull_requests.js`, plus `get_file_contents` | the envelope carries pagination and is self-describing in the rendered text; the harness imposes no output schema on it |
| `ui_get` returns `{method, <method>: <payload>}` | `context.js` | matches upstream's declared `UIGetOutput` shape |
| Helpers that upstream streams or redirects (workflow artifacts, job logs, workflow-run log URLs) return the API endpoint instead of a body | `actions.js` | a host tool returns JSON, not a binary stream; the returned endpoint 302-redirects to the artifact |
| Feature-flag-gated branches (`ThreadResolutionReason`, `update_issue_suggestions`, the MCP-App awaiting-form path) are not gated | `pull_requests.js`, `issues_granular.js` | feature flags are an upstream server-side concept; the behaviour here is always on |
| No interactive confirmation before destructive writes (upstream elicits for e.g. `delete_repository`) | `repos.js` | there is no elicitation channel in this host; `readOnly: true` is the guard |
| Project-item titles are stripped of HTML by a hand-written sanitizer rather than an HTML tokenizer | `governance.js` (`sanitizePlainText`) | ports upstream's `sanitize.PlainText` (code-fence info removal + tag stripping + angle neutralisation) without a new dependency; it does not decode HTML entities the way upstream's tokenizer does |

Anything not listed above is a faithful port of the upstream Go handler.

## License

MIT

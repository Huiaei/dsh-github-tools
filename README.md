# dsh-github-tools

**English** · [简体中文](README.zh.md)

> [!WARNING]
> **Your GitHub token is stored in plaintext.**
> This plugin has no encryption, no keyring, and no secret manager. If you type a token into
> its configuration page, that token is written as an ordinary YAML string into
> `$DSH_HOME/profiles/<profile>/cordis.patch.yml` — readable by any process running as your
> user, readable by **any agent session in that profile**, and carried along by DSH's own
> configuration backup and sync. Treat the token as a file on disk, because that is what it
> is. Use a short-lived, least-privilege token, or keep the token out of the file entirely —
> see [Token and secret storage](#token-and-secret-storage).

> [!CAUTION]
> **This repository was written by an AI, not by a human.**
> The port, the schemas, the tests, the docs — every line — were produced by an AI agent
> working from the upstream [github/github-mcp-server](https://github.com/github/github-mcp-server)
> sources. No human maintainer has reviewed it. It is not affiliated with, endorsed by, or
> supported by GitHub, Microsoft, or DeepSeek. Several tools perform **destructive and
> irreversible** operations against your account: `delete_repository`, `merge_pull_request`,
> `push_files`, `delete_file`, `update_issue_state`, and others. Nothing here has been
> audited for security.

> [!IMPORTANT]
> **Use it entirely at your own risk.**
> There is no warranty of any kind, express or implied — see [LICENSE](LICENSE). You are
> responsible for what these tools do to your repositories, for the credentials you hand
> them, and for the data you let a language model see. If that is not a trade you want to
> make, do not install this.

The complete [github-mcp-server](https://github.com/github/github-mcp-server) tool set —
**131 GitHub tools** — reimplemented as **native DeepSeek Harness (Cordis) plugin tools**.

No MCP server, no child process, no transport, no `mcp__github__*` name prefix: every tool is
registered directly on the harness `tools` service and calls the GitHub REST and GraphQL APIs
over plain `fetch`.

```
GitHub REST / GraphQL  ←  src/client.js  ←  src/handlers/*.js  ←  ctx.tools.register  ←  DSH
```

Contents: [What you get](#what-you-get) · [Requirements](#requirements) · [Install](#install) ·
[Token and secret storage](#token-and-secret-storage) · [Configuration](#configuration) ·
[Settings UI](#settings-ui) · [Tools](#tools) · [How it works](#how-it-works) ·
[Development](#development) · [Troubleshooting](#troubleshooting) ·
[Fidelity and limitations](#fidelity-and-limitations) · [Deviations](#deviations) · [FAQ](#faq)

## What you get

| | MCP stdio server | Remote MCP (HTTP) | **this plugin** |
| --- | --- | --- | --- |
| Process model | resident child process, one per session | none local | none — plain in-process modules |
| Start-up cost | probe process + handshake on every activation | network round trip per call | none |
| Failure mode | a crashed child consumes the reconnect budget | remote availability | an ordinary in-process exception |
| Tool names | `mcp__github__<tool>` | `mcp__github__<tool>` | `<tool>` (e.g. `issue_read`) |
| Auth | env var handed to the child | GitHub-hosted OAuth | the plugin config, or `GITHUB_PERSONAL_ACCESS_TOKEN` |
| Cost of a new tool | rebuild the Go binary / wait for upstream | not under your control | add a handler function |

- **131 tools** across **26 toolsets** (22 of which carry tools today), 60 of them read-only.
- **Zero runtime dependencies.** Plain ESM, no build step, no bundler, nothing to compile.
- **Configurable in the GUI**, with a browser half that ships in the same bundle.
- The tool inventory (names, descriptions, parameter schemas, read-only annotations) is
  **generated from the upstream repository's `__toolsnaps__`**, so the surface the model sees
  matches the Go server. The handlers are a port of the upstream Go implementations.

## Requirements

| | |
| --- | --- |
| DSH | `>= 0.1.7-rc.2` (declared in `engines.dsh`); the peer packages `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery` are supplied by the host |
| Node | `>= 20` (declared in `engines.node`) |
| Build | none — the published package is the source |
| Network | HTTPS to `api.github.com` / `github.com` (or your GitHub Enterprise host) |

## Install

Installing a bundle is a **profile-level** operation: the bundle patch inserts one
process-wide row, so every agent preset in that profile gets the tools without declaring
anything. A restart of DSH is required for the row to activate.

### 1. With the `dsh` CLI (the supported way)

DSH ships a `dsh` command that manages a profile's plugins:

```bash
dsh plugin --profile <profile> add <spec>
```

It runs pnpm **inside the profile directory** and then reconciles the result: it takes a lock
on the profile's `package.json`, checks the plugin's peer and runtime requirements, warns when
a package declares no `dsh.bundle`, validates the bundle's patch files, and — if the package
declares one — **appends the package to `dsh.profile.bundles` for you**. There is nothing to
edit by hand afterwards.

`<spec>` is anything pnpm accepts; DSH validates the shape before use. This package is **not
published to the npm registry**, so use the repository or a local path:

| spec kind | example |
| --- | --- |
| git repository | `dsh plugin --profile desktop add github:Huiaei/dsh-github-tools` |
| hosted repo URL | `dsh plugin --profile desktop add https://github.com/Huiaei/dsh-github-tools` |
| local tarball | `dsh plugin --profile desktop add /abs/path/dsh-github-tools-1.3.0.tgz` |
| local checkout | `dsh plugin --profile desktop add /abs/path/dsh-github-tools` |
| npm package | `dsh plugin --profile desktop add dsh-github-tools` (once it is published) |

A local path must be absolute; `file:` and `link:` prefixes are accepted as well.

Two constraints:

- `--profile` is mandatory — a plugin belongs to exactly one profile.
- For the reserved `desktop` profile, the app must have initialized that profile once and must
  be **fully quit** while the command runs: *"Open DeepSeek Harness Desktop once to initialize
  its profile, then fully quit it before running `dsh plugin --profile desktop`."*

On DSH Desktop the executable is `<install>/resources/runtime/cli/bin/dsh.cmd` (Windows) — put
it on `PATH` or call it by full path. On an npm-installed harness, `dsh` is already on `PATH`.

DSH intercepts a few subcommands of its own (`allow-version`, `revoke-version`, …); everything
else is forwarded to pnpm verbatim, so `remove`, `why`, `list` and friends behave as usual.

### 2. From the GUI

The Plugins page installs from the same spec grammar. The equivalent tool call is:

```
plugin_manager({ action: "install_bundle", target: "<path to .tgz, or an npm spec>" })
```

It reports `application: "restart-required"`.

### 3. By hand

Only if neither of the above is available:

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add /path/to/dsh-github-tools-1.3.0.tgz
```

then add the package name to that profile's `package.json`:

```json
{
  "dsh": { "profile": { "bundles": ["…", "dsh-github-tools"] } }
}
```

and restart DSH. Both edits are required: the dependency puts the code on disk, the bundle
entry activates its patch. A source checkout works the same way — point the dependency at the
checkout (`pnpm add /path/to/dsh-github-tools`, or a `"file:…"` spec) instead of a tarball.
There is no build step, so a checkout runs as-is.

### Verify it loaded

The row should be active, with the browser half resolved to `src/index.js`:

```
plugin_manager({ action: "list_plugins" })
→ { "entryId": "include:github-tools", "enabled": true, "fiberPhase": "active" }
```

Then ask a model to call `get_me`. With a working token it returns your login; without one it
returns GitHub's own `Requires authentication`, which means the plumbing works and only the
credential is missing.

## Token and secret storage

**Read this before you type a token anywhere.**

There is no encryption in this plugin, and none in the harness's plugin-configuration layer.
The plugin's `token` field is a plain string in a plain YAML file. The configuration page
writes through the harness's `configForms` service, which persists to the profile's patch
document:

```
$DSH_HOME/profiles/<profile>/cordis.patch.yml
  - id: github-tools
    config:
      token: ghp_xxxxxxxxxxxxxxxxxxxx        # ← plaintext, right there
```

What that means in practice:

- **Anyone who can read that file has your token.** On Windows the real protection is the ACL
  on your user profile, not the file mode (a WSL view of `/mnt/c` always reports `777`).
- **Any agent session in that profile can read it.** The same shell and file tools an agent
  uses to do its work can read the patch document. A prompt-injected agent does not need a
  vulnerability to exfiltrate it.
- **It travels.** DSH's configuration backup and sync carry the profile document, so the token
  goes wherever that backup goes.
- **`redactSecrets` does not help here.** The harness strips `role('secret')` fields when a
  configuration value crosses a wire boundary and hands back a `{path, set}` sidecar so a
  remote surface can render a write-only input without receiving the value. That is a wire
  boundary control, not disk encryption. Nothing redacts the file.

### What to do about it

Pick one; the first two are the ones that matter.

1. **Use a fine-grained token with a short expiry.** Grant only the repositories and
   permissions you actually need, and set an expiry (30–90 days). A leaked fine-grained token
   is bounded; a leaked classic `ghp_` token with `repo` + `workflow` is not. GitHub's
   fine-grained form: <https://github.com/settings/personal-access-tokens/new>.
   The configuration page links to the classic form with this tool set's scopes pre-filled,
   which is the convenient choice, not the safest one.
2. **Keep the token out of the file.** Leave `token` empty and export it in the environment
   instead. The resolution order is `config.token` → `config.tokenEnv`
   (default `GITHUB_PERSONAL_ACCESS_TOKEN`) → `GITHUB_TOKEN` → `GH_TOKEN`, so an empty `token`
   is a supported, first-class configuration. DSH loads `$DSH_HOME/.env` into the process
   environment at startup (`process.loadEnvFile`), so:

   ```bash
   # $DSH_HOME/.env — gitignored, and not part of the profile's config document
   GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_…
   ```

   This buys *separation*, not encryption: the `.env` file is plaintext too. What it avoids is
   the token riding along in every config backup, sync, and profile snapshot.
3. **Or keep a literal out of the file with a loader expression.** The loader accepts
   expressions in config values, so this is valid YAML:

   ```yaml
   - id: github-tools
     config:
       token: !!js process.env.GITHUB_PERSONAL_ACCESS_TOKEN
   ```

   Caveat: the configuration form writes plain values, so do not press Save on the token field
   afterwards or you will flatten the expression back into a literal.

### What the plugin does do

- The token field in the GUI is a **write-only** control: a stored token is never echoed back,
  and a blank draft writes nothing, so saving the rest of the form cannot wipe it.
- Tokens are sent only to the configured GitHub host, in an `Authorization` header, over
  HTTPS. Nothing is logged, and no telemetry is collected.
- The plugin does not pre-check token scopes; GitHub answers with the usual 403/404.

## Configuration

| key | type | default | meaning |
| --- | --- | --- | --- |
| `token` | string | `''` | PAT or GitHub App installation token |
| `tokenEnv` | string | `GITHUB_PERSONAL_ACCESS_TOKEN` | env var consulted first when `token` is empty |
| `host` | string | `github.com` | `github.com`, or a GitHub Enterprise Server hostname |
| `apiBaseUrl` | string | derived | override the REST base (`https://api.github.com`, `https://<host>/api/v3`) |
| `graphqlUrl` | string | derived | override the GraphQL endpoint |
| `toolsets` | string[] | `['default']` | toolsets to enable; `['all']` enables all 131 |
| `tools` | string[] | `[]` | explicit tool names; when non-empty this **replaces** `toolsets` |
| `excludeTools` | string[] | `[]` | tool names removed from the selection (applied last) |
| `readOnly` | boolean | `false` | register only tools the upstream marks `readOnlyHint: true` (60 of 131) |
| `deferLoading` | boolean | `false` | ask the harness to defer loading the definitions until first use |
| `timeoutMs` | number | `60000` | per-call HTTP timeout |
| `retries` | number | `2` | retries for `429`/`5xx` (honours `Retry-After`) |
| `userAgent` | string | `dsh-github-tools` | `User-Agent` header |
| `maxItems` | number | `1000` | upper bound on items collected by one paginated call |

The default set (the upstream `default: true` toolsets) is `context`, `repos`, `issues`,
`pull_requests`, `users`, `copilot` — 86 tools. `toolsets: ['all']` registers all 131.

Selection order: `tools` (if non-empty) → `toolsets` → `readOnly` → `excludeTools`, applied
last. Every field is a *volatile* configuration leaf, so **edits made in the GUI take effect
live** — changing `toolsets`, `readOnly`, `excludeTools` or `token` re-registers the tool set
in the running session, with no restart. (Installing or removing the bundle itself still
requires a restart.)

### Configuration by file

Without the GUI, the same values live in this bundle's own `cordis.patch.yml`, or in the
profile's `cordis.patch.yml` as an override by id:

```yaml
- id: github-tools
  config:
    toolsets: [repos, issues, pull_requests]
    readOnly: true
```

Override the row by id (`- id: github-tools` with `disabled: true`) in a later patch layer to
keep the tools out of a particular composition.

## Settings UI

The bundle ships a browser half, so its configuration is editable in the GUI. There are two
doors to the same form:

- **Settings → GitHub tools** — the plugin's own entry in the Settings panel.
- **Settings → Plugins → the `dsh-github-tools` row → Configure** — the row's page on the
  Plugins page.

The form writes through the harness's `configForms` service, addressed by the Loader row id
`github-tools`, and renders with the host's own form primitives, so it follows the theme and
the locale. The token control links straight to GitHub's token form with this tool set's
scopes pre-filled.

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

`all`, `default`, `copilot_spaces` and `github_support_docs_search` are meta/empty toolsets:
they select other toolsets or currently expose no tools upstream.

The full per-tool inventory — names, descriptions, toolsets, source file and source function —
is generated into [`docs/TOOLS.md`](docs/TOOLS.md).

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
client/
  index.js            the browser half: the Settings entry, the row page, the form
```

Every handler is `async (args, ctx) => plainObject`; `ctx` carries `client`, `config`, `log`
and `signal`. Registration, schemas, timeouts and rendering live in `src/index.js`, so a
handler never touches the harness. See [`docs/HANDLER-CONTRACT.md`](docs/HANDLER-CONTRACT.md).

Two harness-specific details are worth knowing if you intend to modify this plugin:

- The plugin's `Config` must be reachable as a **named export on the module namespace**. A
  `export default apply` alongside `export const Config` is unwrapped by the loader into the
  bare function, and the configuration row then reports `status: "absent"` — the plugin loads,
  but it has no settings. There is deliberately no default export.
- Every configuration field is `.volatile()`. The harness only serves a configuration
  namespace for entries that have at least one volatile field; without them the Settings page
  waits forever for a namespace that never arrives.

## Development

```bash
node scripts/generate.mjs          # regenerate src/generated/* from a github-mcp-server checkout
node scripts/verify.mjs            # inventory + schema-dialect + handler-coverage check
node --test "tests/**/*.test.mjs"  # unit tests
```

`scripts/generate.mjs` reads `pkg/github/__toolsnaps__/*.snap` and the Go sources from a
github-mcp-server checkout (default `/tmp/gh-mcp`, override with `--source <dir>`); it maps
every tool to its toolset, source file and source function, and rewrites `docs/TOOLS.md`. It is
deterministic — regenerating from the same upstream commit produces byte-identical output.

The test suite includes a local reimplementation of the harness JSON-Schema validator, so the
generated schemas are checked against the real dialect without the harness installed.

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| Every call returns `Requires authentication` | no token reached the client | set `token`, or export `GITHUB_PERSONAL_ACCESS_TOKEN` (see [Token and secret storage](#token-and-secret-storage)) |
| Calls return `403`/`404` on repositories you can see in a browser | the token's scopes or repository access do not cover them | the plugin does not pre-check scopes; check the token's own permissions |
| The tools are not in the model's tool list | the bundle row is disabled, or the profile has not been restarted since install | check `fiberPhase: "active"`; a bundle install needs a restart |
| The Settings page has no entry, or the row has no Configure control | the bundle is older than 1.1.1, or the browser half did not resolve | upgrade; the row must be active for its browser half to load |
| The configuration page spins forever | the bundle is older than 1.1.2 (no volatile fields ⇒ no namespace) | upgrade |
| Changing `toolsets` does nothing until restart | expected before 1.1.2 | on 1.1.2+ the change applies live |
| Install fails with `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` | pnpm's supply-chain policy rejects a version younger than `minimumReleaseAge` | add the package to `minimumReleaseAgeExclude` in the profile's `pnpm-workspace.yaml`, or wait out the cutoff |
| Install fails with `ambiguous-install` | a different tarball at the same version is already installed | bump the version — the manager keys on name + version |
| Tools appear as `mcp__github__*` | that is the upstream MCP server, not this plugin | pick one; running both registers two tool sets |

## Fidelity and limitations

- **Inventory**: 1:1 with the upstream `__toolsnaps__` (141 snapshots → 131 unique tools; the
  extras are `*_output` schema snapshots and feature-flag variants of the same tool).
- **Schemas**: normalized to the harness dialect — `anyOf`/`$ref`/`$defs`/`minimum`/`maximum`/
  `minLength`/`x-mcp-header` are not expressible there and are dropped; the constraint keywords
  that remain (`type`, `oneOf`, `properties`, `required`, `items`, `enum`, `const`) are
  preserved.
- **Output**: the upstream `outputSchema` is not enforced — the plugin declares
  `output.schema = {type: 'json'}`. Handlers return JSON values (objects, plus arrays or raw
  strings where the upstream tool does), rendered as an indented text block; that is what the
  model reads anyway.
- **Scopes**: the plugin does not pre-check token scopes; GitHub returns the usual 403/404.
- **Write tools**: exactly as in the upstream server, write tools perform real changes, with no
  interactive confirmation. Use `readOnly: true` or `excludeTools` to restrict a session.
- **Not audited.** See the warnings at the top.

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

## FAQ

**Is this GitHub's official tooling?** No. It is an independent reimplementation of
github-mcp-server's tool surface, written by an AI, and unaffiliated with GitHub.

**Will it work against GitHub Enterprise Server?** Yes — set `host` to the appliance hostname
and the REST/GraphQL bases are derived; override `apiBaseUrl`/`graphqlUrl` if your deployment
is not at the standard paths.

**Does it need a `gh` CLI login?** No. The plugin reads only its own config and the token
environment variables.

**Can I run it next to the upstream MCP server?** You can, but you will get two overlapping
tool sets, one of them prefixed `mcp__github__`. Pick one.

**How do I keep a session read-only?** Set `readOnly: true`, or list the tools you want in
`tools`. This registers 60 read-only tools instead of 131.

**Where do I report bugs?** Nowhere official — there is no human maintainer. See the warnings
at the top of this file before relying on it.

## Acknowledgements

The tool surface, descriptions, schemas and handler behaviour are derived from
[github/github-mcp-server](https://github.com/github/github-mcp-server) (MIT). This plugin is a
reimplementation for the DeepSeek Harness, not a redistribution.

## License

MIT — see [LICENSE](LICENSE).

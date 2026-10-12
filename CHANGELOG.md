# Changelog

## 1.3.0 — unreleased

Adds a Settings-panel entry and a one-click credential link.

- **A real Settings page.** The browser half registers `settings.section` (id
  `dsh-github-tools`, order 65), so the plugin appears as its own entry in the Settings
  panel beside the shipped sections and dsh-market's page. The earlier
  `settings.plugins.tab` registration only added a tab *inside* Settings -> Built-in
  plugins, which is not where anyone looks for a plugin's configuration.
- **Create the token from the field.** The token control's hint now carries a link to
  GitHub's classic-token form with the scopes this tool set uses and a recognisable
  description pre-filled, so the credential is one click away.
- Packaging tests assert the section registration and the token URL.

## 1.2.0 — unreleased

Rebuilds the configuration page on the platform's own form primitives, and adds a
Settings-page entry.

- **The page is now the shipped settings form.** `SettingsFormModel` stages the drafts,
  `SettingsForm` draws the frame and its single Save, `SettingsValueField` draws the
  text/number/list controls and `SettingsSecretField` the write-only token. That brings
  the standard look, the Overridden badge with Reset to default, per-field validation,
  and the revision-fenced save that keeps a refused draft.
- **The copy is localized again.** The browser half declared only `slots`, so
  `ctx.locale` was never injected, the dictionaries never registered, and every label
  fell back to its key — which read as English-only. It now injects
  `slots`, `locale` and `configForms`, registers `zh`/`en` and binds `t` through the
  slot's `locale`.
- **A second surface:** the same form is registered as a tab in Settings -> Plugins
  (`settings.plugins.tab`) for readers who look for plugin settings there.
- Fields are grouped into Connection / Toolsets / Advanced; booleans use the platform's
  `Switch` instead of a text box.
- `dsh.client.inject` declares `@deepseek-ai/dsh-client-ui-primitives`; packaging tests
  assert the primitives require, the form primitives and both slot registrations.

## 1.1.2 — unreleased

Makes the configuration page actually load, and makes its edits apply live.

- **Every Config field is `.volatile()`.** DSH's settings service projects a plugin's
  config into an editable form only through `volatileForm()`, which keeps a field only
  when its nearest ancestor is volatile, and `SettingsForms.describe()` skips an entry
  whose schema has none. Without a volatile field the namespace is never served, so
  `configForms.whileServed()` never fired and the page stayed on "loading" forever.
- **Volatile fields resolve to live cells, not values.** schemastery wraps them with
  cosmokit's `createVolatile(default)`, so the plugin now reads every field through
  `unbox()`/`readConfig()` at call time. The settings service writes the cell in place,
  which is how an edit reaches a running plugin without a remount.
- **A volatile edit re-syncs the tool set.** `apply()` keeps `name -> disposer` for the
  tools it mounted and diffs it on `loader/volatile-update`, so changing `toolsets`,
  `tools`, `excludeTools` or `readOnly` adds and removes tools live instead of waiting
  for a restart.
- Tests: a live-edit test drives `loader/volatile-update` through default → all → default
  and asserts the mounted set follows; another asserts no Config field lacks volatility.

## 1.1.1 — unreleased

Adds the row configuration page, so the plugin's settings are editable from the GUI.

- New browser half (`client/index.js`, exported as `./client` and declared by `dsh.client`):
  a plain hand-written bundle with no build step, registering the row configuration page
  under the `plugins.row.config` slot with the key `dsh-github-tools#github-tools`. It edits
  `token`, `toolsets`, `readOnly`, `deferLoading` and the advanced connection settings
  through the client `configForms` service, addressed by the Loader row id.
- `cordis.patch.yml` now names the package (`dsh-github-tools`) instead of the relative
  `./src/index.js`: `dsh-client-modules` attaches a package's browser half to the row whose
  specifier is the bare package name, so the relative form left the page unregistered even
  though the Host half loaded.
- Packaging tests assert the browser-half manifest, the ModuleLoader bundle format, the
  `plugins.row.config` key and the bare-name row.

## 1.0.1 — unreleased

Fixes the plugin's settings/config projection and makes every Config field optional.

- **Removed the `export default apply`.** The Cordis loader's `unwrapExports()` replaces the
  plugin object with a module's `default` export, so the exported function became the plugin
  and `Config` disappeared; the harness reported the row as `status: "absent"` and never
  projected a settings schema. The module is now a pure named-export namespace
  (`apply`/`inject`/`name`/`Config`), matching `dsh-wsl-tool`.
- **Every Config field now has a default** (`token: ''`, `apiBaseUrl`/`graphqlUrl: ''`,
  `toolsets: ['default']`, `tools`/`excludeTools: []`, `userAgent: 'dsh-github-tools'`), so the
  shipped `cordis.patch.yml` row — which only sets `token`, `toolsets` and `readOnly` — passes
  schema validation instead of failing activation.
- `scripts/smoke.mjs` uses a namespace import; two regression tests assert the module has no
  default export and that the shipped config row validates.

## 1.0.0 — unreleased

First release: the github-mcp-server tool set as native DeepSeek Harness tools.

- 131 tools across 22 non-empty toolsets, generated from the upstream
  `pkg/github/__toolsnaps__` (141 snapshots → 131 unique tools).
- No MCP server: tools register directly on the host `tools` service and call the GitHub REST
  and GraphQL APIs with `fetch`.
- `GitHubClient`: REST + GraphQL, `Link` pagination, `Retry-After`-aware retries on 429/5xx,
  typed `GitHubApiError`, GitHub Enterprise endpoint derivation.
- Upstream MCP JSON Schema is converted to the harness author schema DSL that `defineTool`
  compiles (property map, explicit `additionalProperties`, `oneOf` unions, `json` fallback).
- Config: `token`/`tokenEnv`, `host`, `toolsets`, `tools`, `excludeTools`, `readOnly`,
  `deferLoading`, `timeoutMs`, `retries`, `userAgent`, `maxItems`.
- Bundle packaging: `cordis.patch.yml`, `locale/en.json` + `locale/zh.json`, `icon.svg`.
- Tests: inventory/schema-dialect, author-spec validator, HTTP client, toolset selection,
  handler contract (all 131), and real-harness checks against `@deepseek-ai/dsh-tools`.
- `scripts/smoke.mjs` exercises read-only tools against the live GitHub API.
- Two read-only audits against the upstream Go source (all 14 handler files) with the
  findings applied: a `list_pull_requests` projection bug that suppressed five fields, and
  in `governance.js` the loss of falsy project-field values, a missing `GraphQL-Features:
  issue_fields` header on the attached-Issue-Fields metadata query, unprojected custom
  property definitions, unvalidated `default_value`, null project timestamps, the wrong
  title sanitizer, a missing `projectItemIssueID` guard, and five project-items batch
  deviations (short-circuit, error mapping, echoed database ID, unconfirmed-chunk handling,
  empty `ref`).
- All 131 tools are wired to a handler and verified by `scripts/verify.mjs`.
- The six largest handler files were audited line-by-line against the upstream Go source. The
  audit's one high-severity finding — `list_pull_requests` dropped `merged_by`, `milestone`,
  `assignees`, `requested_reviewers` and `user.profile_url` because it projected an
  already-minimised object — is fixed, and the remaining deliberate output-shape deviations are
  documented under "Deviations" in the README.

# Changelog

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

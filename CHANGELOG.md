# Changelog

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
- All 131 tools are wired to a handler and verified by `scripts/verify.mjs`.
- The six largest handler files were audited line-by-line against the upstream Go source. The
  audit's one high-severity finding — `list_pull_requests` dropped `merged_by`, `milestone`,
  `assignees`, `requested_reviewers` and `user.profile_url` because it projected an
  already-minimised object — is fixed, and the remaining deliberate output-shape deviations are
  documented under "Deviations" in the README.

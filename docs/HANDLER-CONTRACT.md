# Handler contract — dsh-github-tools

You are implementing **one handler file** of a Cordis/DSH host plugin that reimplements
the [github/github-mcp-server](https://github.com/github/github-mcp-server) tools as native
DSH tools. The plugin entry (`src/index.js`) owns registration, schemas and rendering.
**Your file only maps tool name → async function.**

## 1. The file shape

```js
/**
 * <domain>.js — N tool handlers.
 *   - tool_a
 *   - tool_b
 * Ported from pkg/github/<file>.go
 */

import { fail, requireString, seg, /* … */ } from '../util.js';

/** `tool_a` — one line saying what it does. */
async function toolA(args, ctx) {
  const owner = requireString(args, 'owner');
  const data = await ctx.client.get(`/repos/${seg(owner)}/…`, { signal: ctx.signal });
  return { /* plain JSON */ };
}

export default { tool_a: toolA, tool_b: toolB };
```

Hard rules:

1. **Exactly one export**: `export default { … }`. No named exports, no `import` of
   `@deepseek-ai/*`, no registration, no schema work, no rendering.
2. The keys of the default export **must equal** the tool names assigned to this file in
   `scripts/assignment.json` — same spelling, no extras, no omissions.
3. A handler is `async (args, ctx) => plainObject`. `args` is the raw tool input object
   (already validated by `defineTool` against the parameter spec compiled from the upstream
   `inputSchema`, but **treat every field as possibly absent**). The return value must be a
   **JSON-serializable object** — never `undefined`, `null`, a string, an array, or a class
   instance.
4. Never mutate `args`. Never read `process.env`. Never touch the network directly —
   always go through `ctx.client`.
5. Errors: `fail('message')` (from `../util.js`) throws the tool-visible error. Never
   swallow an API error unless the upstream Go code does; let `GitHubApiError` propagate.
6. ESM only, no TypeScript, no new dependencies, no build step. `node --check <file>` must pass.
7. Respect `ctx.signal`: pass `{ signal: ctx.signal }` on every client call.

## 2. The `ctx` argument

| field | type | notes |
| --- | --- | --- |
| `ctx.client` | `GitHubClient` | the only way to reach GitHub |
| `ctx.config` | object | resolved plugin config: `host`, `apiBaseUrl`, `timeoutMs`, `maxItems` (default 1000), … |
| `ctx.log` | `(message) => void` | safe no-op fallback; use sparingly |
| `ctx.signal` | `AbortSignal` | always forward it |

## 3. `GitHubClient` API (src/client.js)

```js
client.get(path, opts)                 // GET  → decoded JSON body
client.post(path, body, opts)          // POST
client.patch(path, body, opts)         // PATCH
client.put(path, body, opts)           // PUT
client.delete(path, body?, opts)       // DELETE
client.rest(method, path, opts)        // generic
client.getText(path, opts)             // GET with accept: application/vnd.github.raw → string
client.paginate(path, opts)            // follow Link rel=next → array of items
client.search(path, opts)              // /search/* → { total_count, incomplete_results, items }
client.graphql(query, variables, opts) // POST /graphql → data (throws on errors)
client.graphqlPages(query, vars, select, opts) // walk pageInfo.endCursor → nodes
client.graphqlTotalCount(query, vars, select, opts)
client.restUrl(path, query)            // build an absolute URL
```

`opts` (all optional): `{ query, body, headers, signal, raw, expectText, maxItems, perPage,
extract, cursor, maxPages, strict, absolute }`.

- `opts.query` is an object; `undefined`/`null`/`''` values are dropped, arrays become
  repeated params.
- `client.paginate` default `extract` is `Array.isArray(body) ? body : body.items`.
  Pass `extract` for endpoints whose list is nested.
- `client.search` follows pagination until `maxItems` (pass `maxItems: page * per_page`
  when the tool is page-oriented, so one call ≈ one page).
- Throws `GitHubApiError` with `.status`, `.body`, `.errors`, `.toToolMessage()`.
- `client.authenticated` is a boolean; `client.host`, `client.apiBaseUrl` are available.

## 4. `src/util.js` helpers (exact signatures)

```js
toolError(message)                       // Error with name 'GitHubToolError'
fail(message)                            // throw toolError(message)
requireString(args, key, aliases = [])   // trimmed non-empty string or fail()
optionalString(args, key, aliases = [])  // trimmed string or undefined
optionalBoolean(args, key, fallback)     // boolean | 'true' | 'false'
toPositiveInt(value, fallback)           // alias: toInt
clampPerPage(value, fallback = 30)       // 1..100
paginationQuery(args, { defaultPerPage = 30 })  // → { page, per_page }
requireOwnerRepo(args)                   // owner+repo, or repository:"owner/repo" → { owner, repo }
parseRepoSlug(slug)                      // "owner/repo" → { owner, repo }
defined(object)                          // drop undefined values
asArray(value)                           // always an array
requireEnum(value, allowed, argumentName) // case-insensitive match or fail()
seg(value)                               // encodeURIComponent(String(value))
pathSeg(value)                           // encode each path segment, keep "/"
listResult(items, { page, perPage, totalCount })
                                         // → { items, total_count?, page?, per_page?, has_more? }
restList(client, path, args, { query, defaultPerPage, maxItems, signal })
                                         // → { items, page, perPage, raw? }
excerpt(value, length = 500)
pick(object, 'a.b.c')                    // safe nested read
summarizeIssue(issue)                    // { number, title, state, user, labels, … }
repositoryNodeId(client, owner, repo, signal)          // GraphQL global node id
issueDatabaseId(client, owner, repo, number, signal)   // → { databaseId, issue }
```

## 5. Finding your tool definitions and the upstream code

Your tool names and the upstream files that declare them:

```bash
cd /workspace/dsh-github-tools
node -e 'const a=require("./scripts/assignment.json");console.log(a["<file>.js"].join("\n"))'
```

The **authoritative input/output schemas** (extracted from the upstream `.snap` files) are in
`src/generated/tools.json`. Look up one tool:

```bash
node -e '
const t=require("./src/generated/tools.json").tools;
const d=t.find(x=>x.name==="<tool_name>");
console.log(JSON.stringify({inputSchema:d.inputSchema,outputSchema:d.outputSchema,annotations:d.annotations,sourceFile:d.sourceFile,sourceFunc:d.sourceFunc},null,2));'
```

The **upstream Go implementation** is a shallow clone at `/tmp/gh-mcp`:

- `pkg/github/<sourceFile>` holds the handler (`sourceFunc` names it) and its
  `NewToolWithSchemaOptions[In, Out](…)` declaration with the `In`/`Out` structs.
- Read the handler body to reproduce the request path, the parameters, the pagination
  behaviour, the error messages and the **output shape** (the `Out` struct's json tags).
- Useful context: `pkg/github/dependencies.go`, `pkg/github/consolidated_*_types.go`,
  `pkg/github/graphql_helpers.go`, `pkg/tooldiscovery/`, `pkg/github/*_outputs.go`.

Use `grep`/`read` on `/tmp/gh-mcp` — do not re-clone, do not fetch the web.

## 6. Porting guidance

- **Mirror the upstream output shape.** The `outputSchema` in `tools.json` is the contract
  the model sees. Where the upstream Go handler builds a bespoke struct (e.g.
  `MinimalUser`, `MinimalIssue`), reproduce its json tags. Where it returns the raw GitHub
  payload, return the raw payload.
- **Keep the upstream semantics** for: default values, `page`/`perPage` handling, `state`
  filters, `sort`/`order` passthrough, and the exact error strings for missing arguments
  (the harness shows them to the model).
- **Prefer one REST call over GraphQL** unless the upstream uses GraphQL (projects v2,
  discussions, review threads, issue dependencies, custom properties, team membership all
  genuinely need GraphQL — copy the upstream query text and adapt the selection set).
- **Never invent an endpoint.** If you cannot determine the correct call from the upstream
  source, implement the best faithful approximation and add a `// NOTE:` comment saying so.
- Keep functions small; one per tool; a shared private helper is fine when two tools in
  *your* file genuinely share logic. Do not add helpers to `src/util.js` — other agents are
  editing other files concurrently. If a helper is genuinely missing, inline it in your file.
- No `console.log` (use `ctx.log`), no `TODO`, no stub returns.

## 7. Acceptance criteria for your file

```bash
cd /workspace/dsh-github-tools
node --check src/handlers/<file>.js
node -e '
import("./src/handlers/<file>.js").then(async (m)=>{
  const want=require("./scripts/assignment.json")["<file>.js"];
  const got=Object.keys(m.default).sort();
  const missing=want.filter(n=>!got.includes(n));
  const extra=got.filter(n=>!want.includes(n));
  console.log(JSON.stringify({count:got.length,missing,extra,allFunctions:got.every(n=>typeof m.default[n]==="function")}));
});'
```

`missing`, `extra` must be empty and `allFunctions` true. Report the final command output in
your summary, plus a one-line note per tool that is an approximation rather than a faithful port.

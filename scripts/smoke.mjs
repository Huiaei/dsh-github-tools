#!/usr/bin/env node
/**
 * Live smoke test.
 *
 * Registers the plugin exactly the way the harness does (through `apply`), then
 * calls a handful of **read-only** tools against the real GitHub API and prints
 * the outcome of each. Nothing is mutated.
 *
 *   node scripts/smoke.mjs                 # anonymous, public data only
 *   GITHUB_TOKEN=ghp_… node scripts/smoke.mjs
 *
 * Exits non-zero when a call fails for a reason other than a missing token.
 */

import { definitions } from '../src/generated/data.js';
import * as plugin from '../src/index.js';

const token = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || process.env.GH_TOKEN || '';
const TIMEOUT_MS = 30_000;

const cases = [
  { tool: 'get_me', args: {}, needsToken: true },
  { tool: 'search_repositories', args: { query: 'github-mcp-server', perPage: 3 } },
  { tool: 'get_file_contents', args: { owner: 'github', repo: 'github-mcp-server', path: 'README.md' } },
  { tool: 'list_branches', args: { owner: 'octocat', repo: 'Hello-World', perPage: 3 } },
  { tool: 'list_commits', args: { owner: 'octocat', repo: 'Hello-World', perPage: 2 } },
  { tool: 'get_latest_release', args: { owner: 'github', repo: 'github-mcp-server' } },
  { tool: 'list_issues', args: { owner: 'github', repo: 'github-mcp-server', perPage: 2 } },
  { tool: 'list_pull_requests', args: { owner: 'github', repo: 'github-mcp-server', perPage: 2 } },
  { tool: 'get_repository_tree', args: { owner: 'octocat', repo: 'Hello-World', recursive: false } },
  { tool: 'search_code', args: { query: 'repo:github/github-mcp-server package main' } },
  { tool: 'list_releases', args: { owner: 'octocat', repo: 'Hello-World', perPage: 2 } },
  { tool: 'ui_get', args: { method: 'labels', owner: 'octocat', repo: 'Hello-World' } },
];

const registered = new Map();
const logs = [];
const ctx = {
  get: (name) => (name === 'tools' ? { register: (tool) => registered.set(tool.name, tool) } : undefined),
  logger: () => ({
    info: (message) => logs.push(`info: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
    debug: () => {},
  }),
};

console.log(`\ndsh-github-tools — live smoke test${token ? ' (authenticated)' : ' (anonymous)'}\n`);
plugin.apply(ctx, { token, toolsets: ['all'], readOnly: true, timeoutMs: TIMEOUT_MS });

console.log(`registered ${registered.size} read-only tools of ${definitions.length}\n`);

let failures = 0;
let skipped = 0;
for (const testCase of cases) {
  const tool = registered.get(testCase.tool);
  if (tool === undefined) {
    console.log(`  \u001b[33m•\u001b[0m ${testCase.tool}: not registered (skipped)`);
    skipped += 1;
    continue;
  }
  if (testCase.needsToken && token === '') {
    console.log(`  \u001b[33m•\u001b[0m ${testCase.tool}: needs a token (skipped)`);
    skipped += 1;
    continue;
  }
  const started = Date.now();
  try {
    const result = await tool.execute(testCase.args, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const rendered = tool.output.render(testCase.args, result);
    const text = (rendered?.[0]?.text ?? JSON.stringify(result)).replace(/\s+/g, ' ');
    console.log(`  \u001b[32m✓\u001b[0m ${testCase.tool} (${Date.now() - started}ms): ${text.slice(0, 180)}${text.length > 180 ? '…' : ''}`);
  } catch (error) {
    const rateLimited = error.status === 403 && /rate limit/i.test(String(error.message));
    if (rateLimited) {
      skipped += 1;
      console.log(`  \u001b[33m•\u001b[0m ${testCase.tool}: skipped (anonymous rate limit reached — set GITHUB_TOKEN)`);
      continue;
    }
    failures += 1;
    console.log(`  \u001b[31m✗\u001b[0m ${testCase.tool}: ${error.name}: ${String(error.message).slice(0, 240)}`);
  }
}

console.log('');
if (failures === 0) {
  console.log(`\u001b[32mPASS\u001b[0m — ${cases.length - skipped} calls succeeded, ${skipped} skipped\n`);
} else {
  console.log(`\u001b[31mFAIL\u001b[0m — ${failures} call(s) failed, ${skipped} skipped\n`);
  process.exitCode = 1;
}

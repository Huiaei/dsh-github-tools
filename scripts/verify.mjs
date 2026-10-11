#!/usr/bin/env node
/**
 * A single-run acceptance check for the plugin: inventory integrity, harness
 * schema-DSL compliance, handler coverage and per-file porting status.
 *
 *   node scripts/verify.mjs
 *
 * When `@deepseek-ai/dsh-tools` is installed it also compiles every parameter
 * spec with the real `defineTool`. Exits non-zero on the first failed check, so
 * it can gate a commit.
 */

import { readFileSync } from 'node:fs';

import { definitions, toolsets } from '../src/generated/data.js';
import { duplicateHandlers, handlerSources, handlers } from '../src/handlers/index.js';
import { toToolParameters } from '../src/schema.js';
import { validateParameterSpec } from '../tests/helpers/author-spec.mjs';

const assignment = JSON.parse(readFileSync(new URL('./assignment.json', import.meta.url), 'utf8'));

let dshTools = null;
try {
  dshTools = await import('@deepseek-ai/dsh-tools');
} catch {
  dshTools = null;
}

let failures = 0;
const ok = (label, detail = '') => console.log(`  \u001b[32m✓\u001b[0m ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail = '') => {
  failures += 1;
  console.log(`  \u001b[31m✗\u001b[0m ${label}${detail ? ` — ${detail}` : ''}`);
};

console.log('\ndsh-github-tools — verification\n');

// 1. inventory --------------------------------------------------------------
console.log('inventory');
const names = definitions.map((definition) => definition.name);
const unique = new Set(names);
if (definitions.length === 131) ok('131 tool definitions');
else bad('tool definition count', `expected 131, found ${definitions.length}`);
if (unique.size === names.length) ok('all tool names unique');
else bad('duplicate tool names', [...unique].filter((name) => names.filter((entry) => entry === name).length > 1).join(', '));
const toolsetIds = new Set(toolsets.map((entry) => entry.id));
const strayToolsets = definitions.filter((definition) => !toolsetIds.has(definition.toolset));
if (strayToolsets.length === 0) ok(`${toolsets.length} toolsets, every tool assigned`);
else bad('tools with an unknown toolset', strayToolsets.map((definition) => definition.name).join(', '));

// 2. schema DSL -------------------------------------------------------------
console.log('\nschema DSL');
const violations = [];
for (const definition of definitions) {
  for (const violation of validateParameterSpec(toToolParameters(definition.inputSchema))) {
    violations.push(`${definition.name}: ${violation}`);
  }
}
if (violations.length === 0) ok('every parameter spec satisfies the author schema DSL');
else {
  bad(`${violations.length} schema violations`);
  for (const violation of violations.slice(0, 20)) console.log(`      ${violation}`);
  if (violations.length > 20) console.log(`      … and ${violations.length - 20} more`);
}

if (typeof dshTools?.defineTool === 'function') {
  const rejected = [];
  for (const definition of definitions) {
    try {
      dshTools.defineTool({
        name: definition.name,
        description: definition.description,
        parameters: toToolParameters(definition.inputSchema),
        timeoutMs: 1000,
        output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
        async execute() {
          return {};
        },
      });
    } catch (error) {
      rejected.push(`${definition.name}: ${error.message}`);
    }
  }
  if (rejected.length === 0) ok('the real defineTool compiles all 131 specs');
  else {
    bad(`${rejected.length} specs rejected by defineTool`);
    for (const entry of rejected.slice(0, 10)) console.log(`      ${entry}`);
  }
} else {
  console.log('  \u001b[33m•\u001b[0m @deepseek-ai/dsh-tools not installed — skipped the real compiler check (npm install)');
}

// 3. handler coverage -------------------------------------------------------
console.log('\nhandlers');
const missing = names.filter((name) => typeof handlers[name] !== 'function');
const extra = Object.keys(handlers).filter((name) => !unique.has(name));
if (missing.length === 0) ok(`all ${names.length} tools have a handler`);
else bad(`${missing.length} tools have no handler`, missing.join(', '));
if (extra.length === 0) ok('no handler maps to an unknown tool');
else bad('handlers for unknown tools', extra.join(', '));
if (duplicateHandlers.length === 0) ok('no duplicate handler names');
else bad('duplicate handlers', duplicateHandlers.map((entry) => entry.name).join(', '));

const perFile = Object.entries(assignment).map(([file, tools]) => {
  const implemented = tools.filter((name) => typeof handlers[name] === 'function');
  const fromFile = tools.filter((name) => handlerSources[name] === file);
  return { file, expected: tools.length, implemented: implemented.length, sourced: fromFile.length };
});
console.log('\n  file                    tools  handled  wired');
for (const entry of perFile) {
  const wired = entry.sourced === entry.expected && entry.implemented === entry.expected;
  const mark = wired ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m';
  console.log(
    `  ${mark} ${entry.file.padEnd(20)} ${String(entry.expected).padStart(4)} ${String(entry.implemented).padStart(8)} ${String(entry.sourced).padStart(6)}`,
  );
}
if (perFile.some((entry) => entry.sourced !== entry.expected)) bad('some handlers are wired to the wrong file');

// 4. verdict ----------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log(`\u001b[32mPASS\u001b[0m — ${definitions.length} tools, ${toolsets.length} toolsets, ${perFile.length} handler files\n`);
} else {
  console.log(`\u001b[31mFAIL\u001b[0m — ${failures} check(s) failed\n`);
  process.exitCode = 1;
}

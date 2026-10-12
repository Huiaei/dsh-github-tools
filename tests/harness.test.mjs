/**
 * End-to-end checks against the real harness packages.
 *
 * These tests need `@deepseek-ai/dsh-tools` and `@deepseek-ai/schemastery`
 * installed (`npm install`, they are devDependencies) and are skipped when the
 * packages are absent, so a bare checkout still runs the rest of the suite.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { definitions, toolsets } from '../src/generated/data.js';
import { handlers } from '../src/handlers/index.js';
import { toToolParameters } from '../src/schema.js';
import { assertSupportedJsonSchema } from './helpers/dialect.mjs';
import { validateParameterSpec } from './helpers/author-spec.mjs';
import { handlerContext, sampleArgs } from './helpers/mock-client.mjs';

let dshTools = null;
try {
  dshTools = await import('@deepseek-ai/dsh-tools');
} catch {
  dshTools = null;
}
const available = typeof dshTools?.defineTool === 'function';

let plugin = null;
let pluginModule = null;
try {
  pluginModule = await import('../src/index.js');
  // The module must be a plain namespace carrying `apply`/`Config`/`inject`: the loader's
  // `unwrapExports()` collapses a `default` export to that value, which would hide `Config`
  // from the harness (and leave the plugin with no settings schema).
  plugin = typeof pluginModule.apply === 'function' && pluginModule.default === undefined ? pluginModule.apply : null;
} catch {
  plugin = null;
  pluginModule = null;
}

/** A Cordis context whose `tools` service only records registrations. */
function fakeContext() {
  const registered = [];
  const logs = [];
  return {
    registered,
    logs,
    ctx: {
      get: (name) => (name === 'tools' ? { register: (tool) => registered.push(tool) } : undefined),
      logger: () => ({ info: (m) => logs.push(m), error: (m) => logs.push(m), debug: () => {} }),
    },
  };
}

test('the real defineTool accepts every generated parameter spec', { skip: !available }, () => {
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
  assert.deepEqual(rejected, []);
});

test('the real defineTool compiles each spec into a supported raw schema', { skip: !available }, () => {
  for (const definition of definitions) {
    const tool = dshTools.defineTool({
      name: definition.name,
      description: definition.description,
      parameters: toToolParameters(definition.inputSchema),
      timeoutMs: 1000,
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
      async execute() {
        return {};
      },
    });
    assert.doesNotThrow(() => assertSupportedJsonSchema(tool.parameters), `${definition.name}: compiled schema`);
    assert.equal(tool.parameters.type, 'object', `${definition.name}: compiled root`);
    assert.equal(
      Object.prototype.hasOwnProperty.call(tool.parameters, 'additionalProperties'),
      false,
      `${definition.name}: the compiled parameter root stays open`,
    );
  }
});

test('the raw JSON Schema root form is rejected, which is why schema.js converts', { skip: !available }, () => {
  assert.throws(
    () =>
      dshTools.defineTool({
        name: 'raw_root',
        description: 'raw JSON Schema root',
        parameters: { type: 'object', properties: { a: { type: 'string' } } },
        timeoutMs: 1000,
        output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
        async execute() {
          return {};
        },
      }),
    /value schema object|ParameterSchemaSpec/,
  );
});

test('apply() registers every tool the handlers implement', { skip: !available || plugin === null }, () => {
  const { registered, ctx, logs } = fakeContext();
  plugin(ctx, { token: 'x', toolsets: ['all'] });

  const implemented = definitions.map((d) => d.name).filter((name) => typeof handlers[name] === 'function');
  assert.equal(registered.length, implemented.length, 'registered tools must match implemented handlers');
  assert.equal(registered.length, 131, 'every tool should be implemented');
  assert.equal(new Set(registered.map((tool) => tool.name)).size, registered.length, 'tool names must be unique');
  assert.ok(logs.some((line) => line.includes('registered 131/131')), logs.join('\n'));
});

test('apply() honours readOnly and toolset selection', { skip: !available || plugin === null }, () => {
  const { registered, ctx } = fakeContext();
  plugin(ctx, { token: 'x', toolsets: ['all'], readOnly: true });
  const expected = definitions.filter((definition) => definition.annotations?.readOnlyHint === true).length;
  assert.equal(registered.length, expected);
  assert.ok(expected > 0 && expected < definitions.length);
});

test('the plugin Config applies its defaults', { skip: pluginModule === null }, () => {
  const resolved = pluginModule.Config({ token: 'abc' });
  assert.equal(resolved.token, 'abc');
  assert.equal(resolved.host, 'github.com');
  assert.equal(resolved.timeoutMs, 60_000);
  assert.equal(resolved.readOnly, false);
  assert.equal(resolved.maxItems, 1_000);
});

test('the plugin module stays a namespace so the harness can project Config', { skip: pluginModule === null }, () => {
  // A `default` export makes the loader's unwrapExports() replace the plugin object with that
  // value, which hides `Config` and leaves the row with status "absent" (no settings schema).
  assert.equal(pluginModule.default, undefined, 'the module must not have a default export');
  assert.equal(typeof pluginModule.apply, 'function');
  assert.notEqual(pluginModule.Config, undefined);
  assert.deepEqual(pluginModule.inject, ['tools']);
});

test('the shipped config row satisfies the plugin Config schema', { skip: pluginModule === null }, () => {
  // Mirrors the `config:` block of cordis.patch.yml: every other field must have a default,
  // otherwise the loader rejects the row and the plugin never activates.
  const resolved = pluginModule.Config({ token: '', toolsets: ['default'], readOnly: false });
  assert.deepEqual(resolved.toolsets, ['default']);
  assert.deepEqual(resolved.tools, []);
  assert.deepEqual(resolved.excludeTools, []);
  assert.equal(resolved.apiBaseUrl, '');
  assert.equal(resolved.graphqlUrl, '');
  assert.equal(resolved.userAgent, 'dsh-github-tools');
  assert.equal(resolved.tokenEnv, 'GITHUB_PERSONAL_ACCESS_TOKEN');
  assert.equal(resolved.deferLoading, false);
  assert.equal(resolved.retries, 2);
});

test('the author spec validator agrees with the real compiler', { skip: !available }, () => {
  const cases = [
    { a: { type: 'string', required: true } },
    { a: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
    { a: { type: 'object', additionalProperties: false, properties: { b: { type: 'integer', required: true } } } },
    { a: { type: 'array', items: { type: 'string' } } },
    { a: { type: 'json' } },
  ];
  for (const spec of cases) {
    assert.deepEqual(validateParameterSpec(spec), [], `validator rejected ${JSON.stringify(spec)}`);
    assert.doesNotThrow(() =>
      dshTools.defineTool({
        name: 'case',
        description: 'case',
        parameters: spec,
        timeoutMs: 1000,
        output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
        async execute() {
          return {};
        },
      }),
    );
  }

  const bad = [{ a: { type: 'object', properties: {} } }, { a: { type: 'string', required: false } }, { a: { required: true } }];
  for (const spec of bad) {
    assert.notDeepEqual(validateParameterSpec(spec), [], `validator accepted ${JSON.stringify(spec)}`);
    assert.throws(() =>
      dshTools.defineTool({
        name: 'case',
        description: 'case',
        parameters: spec,
        timeoutMs: 1000,
        output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
        async execute() {
          return {};
        },
      }),
    );
  }
});

test('every tool executes through defineTool with schema-derived arguments', { skip: !available }, async () => {
  const problems = [];
  for (const definition of definitions) {
    const handler = handlers[definition.name];
    if (typeof handler !== 'function') {
      problems.push(`${definition.name}: no handler`);
      continue;
    }
    const tool = dshTools.defineTool({
      name: definition.name,
      description: definition.description,
      parameters: toToolParameters(definition.inputSchema),
      timeoutMs: 1000,
      output: { schema: { type: 'object', additionalProperties: true }, render: () => [] },
      async execute(args) {
        return handler(args ?? {}, handlerContext());
      },
    });
    const args = sampleArgs(toToolParameters(definition.inputSchema));
    try {
      const result = await tool.execute(args, { signal: undefined });
      if (result === undefined) problems.push(`${definition.name}: returned undefined`);
      else JSON.stringify(result);
    } catch (error) {
      if (error?.name === 'ToolArgsError') problems.push(`${definition.name}: argument validation rejected the sample args — ${error.message}`);
      else if (!(error instanceof Error) || !error.message) problems.push(`${definition.name}: threw ${String(error)}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the generated toolsets cover the definitions', { skip: !available }, () => {
  const ids = new Set(toolsets.map((entry) => entry.id));
  assert.equal(definitions.every((definition) => ids.has(definition.toolset)), true);
});

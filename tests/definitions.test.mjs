/**
 * The generated tool inventory must stay in lock-step with the upstream
 * `__toolsnaps__`, and every parameter spec must be accepted by the harness
 * author schema DSL that `defineTool` compiles.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { definitions, generatedFrom, source, toolsets } from '../src/generated/data.js';
import { toOutputSchema, toToolParameters } from '../src/schema.js';
import { validateParameterSpec } from './helpers/author-spec.mjs';

const assignment = JSON.parse(readFileSync(new URL('../scripts/assignment.json', import.meta.url), 'utf8'));

test('the inventory has 131 uniquely named tools', () => {
  assert.equal(definitions.length, 131);
  const names = definitions.map((definition) => definition.name);
  assert.equal(new Set(names).size, names.length, 'duplicate tool names');
  assert.ok(source, 'the inventory records its upstream source');
  assert.ok(generatedFrom, 'the inventory records what it was generated from');
});

test('every tool carries the metadata the plugin needs', () => {
  for (const definition of definitions) {
    assert.equal(typeof definition.name, 'string', `${definition.name}: name`);
    assert.ok(definition.name.length > 0);
    assert.equal(typeof definition.description, 'string', `${definition.name}: description`);
    assert.ok(definition.description.length > 0, `${definition.name}: description must not be empty`);
    assert.equal(typeof definition.toolset, 'string', `${definition.name}: toolset`);
    assert.equal(typeof definition.sourceFile, 'string', `${definition.name}: sourceFile`);
    assert.equal(typeof definition.sourceFunc, 'string', `${definition.name}: sourceFunc`);
    assert.ok(definition.inputSchema && typeof definition.inputSchema === 'object', `${definition.name}: inputSchema`);
  }
});

test('every tool belongs to a declared toolset', () => {
  const ids = new Set(toolsets.map((entry) => entry.id));
  for (const definition of definitions) {
    assert.ok(ids.has(definition.toolset), `${definition.name}: unknown toolset ${definition.toolset}`);
  }
  assert.ok(toolsets.length > 0);
  assert.ok(toolsets.some((entry) => entry.default), 'at least one toolset is enabled by default');
});

test('every generated parameter spec is accepted by the author schema DSL', () => {
  const violations = [];
  for (const definition of definitions) {
    for (const violation of validateParameterSpec(toToolParameters(definition.inputSchema))) {
      violations.push(`${definition.name}: ${violation}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('the parameter spec is a property map keyed by the upstream property names', () => {
  for (const definition of definitions) {
    const spec = toToolParameters(definition.inputSchema);
    assert.equal(Array.isArray(spec), false, `${definition.name}: parameters must be a map, not an array`);
    assert.equal(typeof spec, 'object', `${definition.name}: parameters must be an object`);
    // Property names are arbitrary: `type`, `items` and `properties` are real
    // upstream parameter names (e.g. custom_properties_write takes `properties`).
    const expected = Object.keys(definition.inputSchema?.properties ?? {});
    assert.deepEqual(Object.keys(spec).sort(), expected.sort(), `${definition.name}: property names changed`);
  }
});

test('required flags mirror the upstream required list', () => {
  for (const definition of definitions) {
    const spec = toToolParameters(definition.inputSchema);
    const required = new Set(
      Array.isArray(definition.inputSchema?.required) ? definition.inputSchema.required.filter((n) => typeof n === 'string') : [],
    );
    for (const [name, value] of Object.entries(spec)) {
      assert.equal(value.required === true, required.has(name), `${definition.name}.${name}: required flag mismatch`);
      assert.ok(Object.hasOwn(value, 'type') || Object.hasOwn(value, 'oneOf'), `${definition.name}.${name}: needs type or oneOf`);
    }
  }
});

test('every object node declares an explicit boolean additionalProperties', () => {
  const walk = (node, path, errors) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node.oneOf)) {
      node.oneOf.forEach((branch, index) => walk(branch, `${path}.oneOf[${index}]`, errors));
      return;
    }
    if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
      errors.push(`${path}: object node without additionalProperties`);
    }
    if (node.type === 'object' && node.properties) {
      for (const [name, child] of Object.entries(node.properties)) walk(child, `${path}.properties.${name}`, errors);
    }
    if (node.type === 'array' && node.items) walk(node.items, `${path}.items`, errors);
  };
  const errors = [];
  for (const definition of definitions) {
    for (const [name, value] of Object.entries(toToolParameters(definition.inputSchema))) {
      walk(value, `${definition.name}.${name}`, errors);
    }
  }
  assert.deepEqual(errors, []);
});

test('unsupported upstream keywords are dropped, supported ones survive', () => {
  const spec = toToolParameters({
    type: 'object',
    additionalProperties: false,
    properties: {
      sha: { type: 'string', minLength: 1, 'x-mcp-header': 'sha', description: 'the ref' },
      detail: { type: 'string', enum: ['full', 'summary', 'none'], default: 'summary' },
    },
    required: ['sha'],
  });
  assert.deepEqual(spec.sha, { description: 'the ref', type: 'string', required: true });
  assert.deepEqual(spec.detail, { type: 'string', enum: ['full', 'summary', 'none'], default: 'summary' });
  assert.deepEqual(validateParameterSpec(spec), []);
});

test('required entries naming undeclared properties are dropped', () => {
  const spec = toToolParameters({
    type: 'object',
    properties: { owner: { type: 'string' } },
    required: ['owner', 'ghost'],
  });
  assert.equal(spec.owner.required, true);
  assert.equal(Object.hasOwn(spec, 'ghost'), false);
});

test('nullable anyOf unions become a two-branch oneOf', () => {
  const spec = toToolParameters({
    type: 'object',
    properties: { cursor: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  });
  assert.equal(spec.cursor.type, undefined);
  assert.deepEqual(spec.cursor.oneOf, [{ type: 'string' }, { type: 'null' }]);
  assert.deepEqual(validateParameterSpec(spec), []);
});

test('nested objects keep their own required flags', () => {
  const spec = toToolParameters({
    type: 'object',
    properties: {
      filter: {
        type: 'object',
        properties: { state: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } },
        required: ['state'],
      },
    },
  });
  assert.equal(spec.filter.type, 'object');
  assert.equal(spec.filter.additionalProperties, true);
  assert.equal(spec.filter.properties.state.required, true);
  assert.equal(spec.filter.properties.labels.required, undefined);
  assert.deepEqual(spec.filter.properties.labels.items, { type: 'string' });
  assert.deepEqual(validateParameterSpec(spec), []);
});

test('a typeless node degrades to the json author type', () => {
  const spec = toToolParameters({ type: 'object', properties: { anything: {} } });
  assert.deepEqual(spec.anything, { type: 'json' });
  assert.deepEqual(validateParameterSpec(spec), []);
});

test('output schemas degrade to an open object rather than throwing', () => {
  assert.deepEqual(toOutputSchema(null), { type: 'object', additionalProperties: true });
  assert.deepEqual(toOutputSchema(undefined), { type: 'object', additionalProperties: true });
  const fromUpstream = toOutputSchema({ type: 'object', properties: { ok: { type: 'boolean' } } });
  assert.equal(fromUpstream.type, 'object');
  assert.equal(fromUpstream.additionalProperties, true);
});

test('the assignment table partitions the inventory without gaps or overlaps', () => {
  const assigned = new Map();
  for (const [file, names] of Object.entries(assignment)) {
    for (const name of names) {
      assert.equal(assigned.has(name), false, `${name} is assigned to both ${assigned.get(name)} and ${file}`);
      assigned.set(name, file);
    }
  }
  const known = new Set(definitions.map((definition) => definition.name));
  const unassigned = [...known].filter((name) => !assigned.has(name));
  const stray = [...assigned.keys()].filter((name) => !known.has(name));
  assert.deepEqual(unassigned, [], 'tools with no assigned handler file');
  assert.deepEqual(stray, [], 'handler assignments that name no known tool');
  assert.equal(assigned.size, 131);
});

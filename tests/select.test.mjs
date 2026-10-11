/**
 * Toolset selection mirrors the upstream server's semantics.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { definitions, toolsets } from '../src/generated/data.js';
import { resolveToolsets, selectTools } from '../src/select.js';

const defaultIds = toolsets.filter((entry) => entry.default).map((entry) => entry.id);

test('an empty request enables the default toolsets', () => {
  const enabled = resolveToolsets([], toolsets);
  assert.deepEqual([...enabled].sort(), [...defaultIds].sort());
  assert.ok(defaultIds.length > 0);
});

test("'all' enables every toolset", () => {
  const enabled = resolveToolsets(['all'], toolsets);
  assert.equal(enabled.size, toolsets.length);
});

test("'default' expands to the default toolsets", () => {
  const enabled = resolveToolsets(['default'], toolsets);
  assert.deepEqual([...enabled].sort(), [...defaultIds].sort());
});

test('unknown toolsets are reported and ignored', () => {
  const selection = selectTools({ definitions, toolsets, config: { toolsets: ['repos', 'nope'] } });
  assert.deepEqual(selection.unknownToolsets, ['nope']);
  assert.deepEqual(selection.enabledToolsets, ['repos']);
  assert.ok(selection.selected.every((definition) => definition.toolset === 'repos'));
});

test('an explicit tool list overrides the toolset selection', () => {
  const selection = selectTools({ definitions, toolsets, config: { toolsets: ['repos'], tools: ['get_me', 'list_issues'] } });
  assert.deepEqual(selection.selected.map((definition) => definition.name), ['get_me', 'list_issues']);
});

test('unknown tool names are reported and ignored', () => {
  const selection = selectTools({ definitions, toolsets, config: { tools: ['get_me', 'not_a_tool'] } });
  assert.deepEqual(selection.unknownTools, ['not_a_tool']);
  assert.deepEqual(selection.selected.map((definition) => definition.name), ['get_me']);
});

test('excludeTools is applied last', () => {
  const selection = selectTools({ definitions, toolsets, config: { tools: ['get_me', 'get_teams'], excludeTools: ['get_teams'] } });
  assert.deepEqual(selection.selected.map((definition) => definition.name), ['get_me']);
});

test('readOnly keeps only the upstream read-only tools', () => {
  const selection = selectTools({ definitions, toolsets, config: { toolsets: ['all'], readOnly: true } });
  assert.ok(selection.selected.length > 0);
  assert.ok(selection.selected.every((definition) => definition.annotations?.readOnlyHint === true));
  assert.ok(selection.droppedByReadOnly.length > 0);
  assert.equal(selection.selected.length + selection.droppedByReadOnly.length, definitions.length);
});

test("'all' selects the whole inventory", () => {
  const selection = selectTools({ definitions, toolsets, config: { toolsets: ['all'] } });
  assert.equal(selection.selected.length, definitions.length);
});

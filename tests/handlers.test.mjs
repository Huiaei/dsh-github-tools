/**
 * Every generated tool must have exactly one handler, and every handler must
 * honour the handler contract in `docs/HANDLER-CONTRACT.md`: it takes
 * `(args, ctx)` and returns a JSON-serializable object (or throws an Error).
 *
 * The smoke call uses a stub client, so it proves the wiring and the return
 * shape — not the HTTP semantics. Anything the stub cannot satisfy is allowed to
 * throw; what is *not* allowed is returning `undefined`, `null`, an array or a
 * string, which would break the harness output pipeline.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { definitions } from '../src/generated/data.js';
import { duplicateHandlers, handlerSources, handlers } from '../src/handlers/index.js';
import { toToolParameters } from '../src/schema.js';
import { handlerContext, sampleArgs } from './helpers/mock-client.mjs';

const assignment = JSON.parse(readFileSync(new URL('../scripts/assignment.json', import.meta.url), 'utf8'));

test('there are no duplicate handler names across files', () => {
  assert.deepEqual(duplicateHandlers, []);
});

test('every tool has a handler and every handler maps to a tool', () => {
  const known = new Set(definitions.map((definition) => definition.name));
  const missing = definitions.map((definition) => definition.name).filter((name) => typeof handlers[name] !== 'function');
  const extra = Object.keys(handlers).filter((name) => !known.has(name));
  assert.deepEqual(missing, [], 'tools with no handler implementation');
  assert.deepEqual(extra, [], 'handlers that map to no generated tool');
});

test('the handler registry matches the assignment table', () => {
  for (const [file, names] of Object.entries(assignment)) {
    const source = handlerSources[names[0]];
    assert.equal(source, file, `${names[0]} should come from ${file}, not ${source}`);
  }
});

test('every handler file default-exports only functions', async () => {
  for (const [file, names] of Object.entries(assignment)) {
    const module = await import(`../src/handlers/${file}`);
    assert.deepEqual(Object.keys(module).sort(), ['default'], `${file}: must only default-export`);
    for (const name of names) {
      assert.equal(typeof module.default[name], 'function', `${file}: ${name} must be a function`);
    }
  }
});

for (const definition of definitions) {
  test(`handler contract: ${definition.name}`, async () => {
    const handler = handlers[definition.name];
    assert.equal(typeof handler, 'function', `${definition.name} has no handler`);

    const args = sampleArgs(toToolParameters(definition.inputSchema));
    let result;
    try {
      result = await handler(args, handlerContext());
    } catch (error) {
      assert.ok(error instanceof Error, `${definition.name} threw a non-Error value`);
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.length > 0, `${definition.name} threw an Error with an empty message`);
      return;
    }

    assert.notEqual(result, undefined, `${definition.name} returned undefined`);
    assert.doesNotThrow(() => JSON.stringify(result), `${definition.name} returned a non-serializable value`);
    const shape = Array.isArray(result) ? 'array' : typeof result;
    assert.ok(
      ['object', 'array', 'string', 'number', 'boolean'].includes(shape),
      `${definition.name} returned a ${shape}, which the renderer cannot present`,
    );
  });
}

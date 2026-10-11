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

const assignment = JSON.parse(readFileSync(new URL('../scripts/assignment.json', import.meta.url), 'utf8'));

/** A GitHubClient stand-in: records calls, never touches the network. */
function mockClient() {
  const calls = [];
  const record = (method, path, options) => {
    calls.push({ method, path, options });
    return calls.length;
  };
  return {
    calls,
    authenticated: true,
    host: 'github.com',
    apiBaseUrl: 'https://api.github.com',
    restUrl: (path) => `https://api.github.com/${String(path).replace(/^\/+/, '')}`,
    async get(path, options) {
      record('GET', path, options);
      return [];
    },
    async post(path, body, options) {
      record('POST', path, options);
      return {};
    },
    async patch(path, body, options) {
      record('PATCH', path, options);
      return {};
    },
    async put(path, body, options) {
      record('PUT', path, options);
      return {};
    },
    async delete(path, body, options) {
      record('DELETE', path, options);
      return {};
    },
    async rest(method, path, options) {
      record(method, path, options);
      return [];
    },
    async getText(path, options) {
      record('GETTEXT', path, options);
      return '';
    },
    async paginate(path, options) {
      record('PAGINATE', path, options);
      return [];
    },
    async search(path, options) {
      record('SEARCH', path, options);
      return { total_count: 0, incomplete_results: false, items: [] };
    },
    async graphql(query, variables, options) {
      record('GRAPHQL', query, options);
      return {};
    },
    async graphqlPages() {
      return [];
    },
    async graphqlTotalCount() {
      return 0;
    },
  };
}

function sampleValue(schema) {
  if (!schema || typeof schema !== 'object') return 'x';
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) return sampleValue(schema.oneOf[0]);
  switch (schema.type) {
    case 'string':
      return 'x';
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'x';
  }
}

function sampleArgs(parameters) {
  const args = {};
  for (const [name, schema] of Object.entries(parameters.properties ?? {})) {
    args[name] = sampleValue(schema);
  }
  return args;
}

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

for (const definition of definitions) {
  test(`handler contract: ${definition.name}`, async () => {
    const handler = handlers[definition.name];
    assert.equal(typeof handler, 'function', `${definition.name} has no handler`);

    const ctx = {
      client: mockClient(),
      config: { host: 'github.com', maxItems: 10, timeoutMs: 1000 },
      log: () => {},
      signal: undefined,
    };

    let result;
    try {
      result = await handler(sampleArgs(toToolParameters(definition.inputSchema)), ctx);
    } catch (error) {
      assert.ok(error instanceof Error, `${definition.name} threw a non-Error value`);
      assert.equal(typeof error.message, 'string');
      assert.ok(error.message.length > 0, `${definition.name} threw an Error with an empty message`);
      return;
    }

    assert.notEqual(result, undefined, `${definition.name} returned undefined`);
    assert.notEqual(result, null, `${definition.name} returned null`);
    assert.equal(typeof result, 'object', `${definition.name} must return an object, got ${typeof result}`);
    assert.equal(Array.isArray(result), false, `${definition.name} must return an object, not an array`);
    assert.doesNotThrow(() => JSON.stringify(result), `${definition.name} returned a non-serializable value`);
  });
}

/**
 * Shared test doubles: a GitHubClient stand-in that never touches the network,
 * plus helpers that derive plausible arguments from a tool's parameter spec.
 */

/** A GitHubClient stand-in: records every call, returns benign shapes. */
export function mockClient() {
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

/** A plausible value for one author-schema property. */
export function sampleValue(schema) {
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

/**
 * Build arguments that satisfy the parameter spec: every declared property is
 * present (the required ones obviously, and the optional ones so more of each
 * handler's body is exercised).
 */
export function sampleArgs(spec) {
  const args = {};
  for (const [name, schema] of Object.entries(spec ?? {})) {
    args[name] = sampleValue(schema);
  }
  return args;
}

/** A `ctx` object of the shape every handler receives. */
export function handlerContext(overrides = {}) {
  return {
    client: mockClient(),
    config: { host: 'github.com', maxItems: 10, timeoutMs: 1000 },
    log: () => {},
    signal: undefined,
    ...overrides,
  };
}

/**
 * Assert the handler result honours the contract: a JSON-serializable object,
 * or a thrown Error with a non-empty message.
 * @returns {{kind: 'result'|'error', value: unknown}}
 */
export function assertResultShape(assert, label, result) {
  assert.notEqual(result, undefined, `${label} returned undefined`);
  assert.notEqual(result, null, `${label} returned null`);
  assert.equal(typeof result, 'object', `${label} must return an object, got ${typeof result}`);
  assert.equal(Array.isArray(result), false, `${label} must return an object, not an array`);
  assert.doesNotThrow(() => JSON.stringify(result), `${label} returned a non-serializable value`);
  return { kind: 'result', value: result };
}

/**
 * schema.js — turn the upstream MCP JSON Schema into the harness author schema.
 *
 * The harness does **not** take raw JSON Schema for `parameters`. `defineTool`
 * compiles an author-facing DSL (`ParameterSchemaSpec`), and each property of
 * that map must be a *value schema object*:
 *
 *   - a node is either `{ type: … }` or `{ oneOf: [ … ] }`, never both
 *   - `type` is one of string / number / integer / boolean / null / array /
 *     object / json (`json` means "any JSON value" and compiles to an
 *     annotation-only schema)
 *   - annotations: `description`, `title`, `default`, `examples`
 *   - `object` nodes must carry an explicit boolean `additionalProperties`, and
 *     may carry `properties` (a property map)
 *   - `array` nodes may carry `items` (one value schema)
 *   - scalar nodes may carry `enum` (non-empty, all scalars) or `const`
 *   - a property may set `required: true` — only `true`, and only in a property
 *     position
 *
 * The compiler then produces the enforced raw JSON Schema subset and asserts it:
 *
 *   constraint keywords: type | oneOf | properties | required | additionalProperties | items | enum | const
 *   annotations:         description | title | default | examples
 *
 * The upstream schemas are ordinary MCP JSON Schema: they use `anyOf` for
 * nullable parameters, plus `minimum`/`maximum`/`minLength`/`maxItems`/
 * `x-mcp-header` and `$ref`/`$defs`/`$schema`. Everything the DSL cannot express
 * is dropped here, unions become `oneOf`, and a node with no usable type falls
 * back to `json` so it can never end up in the illegal "constraints without a
 * type" shape.
 *
 * `toToolParameters` therefore returns the **property map** (the author spec),
 * not a raw object schema; `toOutputSchema` returns one author value schema.
 */

const CONSTRAINT_KEYWORDS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];
const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples'];
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

/** The author type meaning "any JSON value"; compiles to an annotation-only schema. */
const ANY_TYPE = 'json';

/** Property names that need `Object.defineProperty` to stay data. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON type name used by the schema dialect. */
function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'object':
      return 'object';
    default:
      return null;
  }
}

/** Whether a scalar satisfies a declared type. `number` accepts integers. */
function scalarMatches(type, value) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return false;
  }
}

function setKey(target, key, value) {
  if (UNSAFE_KEYS.has(key)) return;
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** Copy the annotation vocabulary, dropping anything that is not plain JSON. */
function copyAnnotations(node, out) {
  for (const key of ANNOTATION_KEYWORDS) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    try {
      if (JSON.parse(JSON.stringify(value)) === undefined) continue;
    } catch {
      continue;
    }
    out[key] = value;
  }
}

/** Infer the declared type from whatever constraint keywords the node carries. */
function inferType(node) {
  if (Object.hasOwn(node, 'properties') || Object.hasOwn(node, 'required') || Object.hasOwn(node, 'additionalProperties')) {
    return 'object';
  }
  if (Object.hasOwn(node, 'items')) return 'array';
  if (Object.hasOwn(node, 'const')) {
    const type = jsonTypeOf(node.const);
    return type === 'integer' ? 'number' : type;
  }
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const type = jsonTypeOf(node.enum[0]);
    return type === 'integer' ? 'number' : type;
  }
  return undefined;
}

/**
 * Build a property map (`{ name: valueSchema }`) and mark the required names.
 * @param {object} properties
 * @param {Iterable<string>} requiredNames
 */
function toPropertyMap(properties, requiredNames) {
  const required = new Set(requiredNames);
  const spec = {};
  for (const [name, child] of Object.entries(properties)) {
    const value = toAuthorValue(child);
    if (required.has(name)) value.required = true;
    setKey(spec, name, value);
  }
  return spec;
}

/**
 * Convert one upstream JSON Schema node into an author value schema.
 * Never returns `undefined`: an unusable node degrades to `{ type: 'json' }`.
 * @param {unknown} node
 * @returns {object}
 */
function toAuthorValue(node) {
  if (!isPlainObject(node)) return { type: ANY_TYPE };

  const annotations = {};
  copyAnnotations(node, annotations);

  const declaredType = typeof node.type === 'string' && SCHEMA_TYPES.includes(node.type) ? node.type : undefined;

  // Unions: `anyOf` and `oneOf` both become `oneOf`, which may not sit beside a
  // declared `type`.
  if (declaredType === undefined) {
    const union = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : undefined;
    if (union !== undefined) {
      const variants = [];
      for (const candidate of union) {
        const variant = toAuthorValue(candidate);
        // A `oneOf` branch may not carry `required`.
        if (variant.required !== undefined) delete variant.required;
        variants.push(variant);
      }
      if (variants.length === 1) return { ...variants[0], ...annotations, ...(variants[0].required ? { required: true } : {}) };
      if (variants.length >= 2) return { ...annotations, oneOf: variants };
    }
  }

  const type = declaredType ?? inferType(node) ?? ANY_TYPE;
  const out = { ...annotations, type };

  if (type === 'object') {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    const requiredNames = Array.isArray(node.required) ? node.required.filter((name) => typeof name === 'string') : [];
    if (Object.keys(properties).length > 0) {
      out.properties = toPropertyMap(properties, requiredNames);
    }
    // The author DSL demands an explicit boolean here; absent means "open".
    out.additionalProperties = typeof node.additionalProperties === 'boolean' ? node.additionalProperties : true;
    return out;
  }

  if (type === 'array') {
    if (isPlainObject(node.items)) out.items = toAuthorValue(node.items);
    return out;
  }

  if (type === ANY_TYPE) return out;

  if (Array.isArray(node.enum)) {
    const allowed = node.enum.filter((entry) => scalarMatches(type, entry));
    if (allowed.length > 0) out.enum = allowed;
  }
  if (Object.hasOwn(node, 'const') && scalarMatches(type, node.const)) out.const = node.const;
  return out;
}

/**
 * Convert an upstream `inputSchema` into the harness parameter spec.
 * @param {unknown} schema - the upstream `inputSchema`.
 * @returns {Record<string, object>} the property map `defineTool` expects.
 */
export function toToolParameters(schema) {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return {};
  const requiredNames = Array.isArray(schema.required) ? schema.required.filter((name) => typeof name === 'string') : [];
  return toPropertyMap(schema.properties, requiredNames);
}

/**
 * Convert an upstream `outputSchema` into one author value schema.
 * @param {unknown} schema - the upstream `outputSchema` (may be null).
 * @returns {object} a schema usable as `output.schema`; never throws.
 */
export function toOutputSchema(schema) {
  if (!isPlainObject(schema)) return { type: 'object', additionalProperties: true };
  const value = toAuthorValue(schema);
  if (value.type === undefined && value.oneOf === undefined) return { ...value, type: ANY_TYPE };
  return value;
}

export { SCHEMA_TYPES, CONSTRAINT_KEYWORDS, ANNOTATION_KEYWORDS, ANY_TYPE };

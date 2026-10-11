/**
 * A local reimplementation of the harness JSON-Schema dialect check.
 *
 * The host validates every registered tool's `parameters` with the same rules
 * (`assertSupportedJsonSchema` in @deepseek-ai/dsh-tools). Reimplementing it here
 * keeps the test suite runnable without the harness installed, and lets the
 * definitions be validated in CI before a plugin is ever loaded.
 */

export const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];

export const CONSTRAINT_KEYWORDS = [
  'type',
  'oneOf',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
];

export const ANNOTATION_KEYWORDS = ['description', 'title', 'default', 'examples'];

/** Keywords that may not sit next to `oneOf` on the same node. */
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

/** Keywords that require `type` (or `oneOf`) on the same node. */
const NEEDS_TYPE = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

const ALLOWED = new Set([...CONSTRAINT_KEYWORDS, ...ANNOTATION_KEYWORDS]);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function matchesType(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return true;
  }
}

/**
 * @param {unknown} node
 * @param {string} path JSON-pointer-ish location for error messages
 * @param {string[]} errors
 * @param {WeakSet<object>} seen
 */
export function checkSchemaNode(node, path = '$', errors = [], seen = new WeakSet()) {
  if (!isPlainObject(node)) {
    errors.push(`${path}: schema node must be an object`);
    return errors;
  }
  if (seen.has(node)) {
    errors.push(`${path}: circular schema reference`);
    return errors;
  }
  seen.add(node);

  for (const key of Object.keys(node)) {
    if (!ALLOWED.has(key)) errors.push(`${path}.${key}: is not a supported keyword`);
  }

  const hasType = 'type' in node;
  const hasOneOf = 'oneOf' in node;

  if (hasType) {
    const type = node.type;
    if (Array.isArray(type)) errors.push(`${path}.type: union types are not supported`);
    else if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      errors.push(`${path}.type: unsupported type ${JSON.stringify(type)}`);
    }
  }

  if (hasOneOf) {
    if (hasType) errors.push(`${path}: type and oneOf cannot be combined`);
    for (const sibling of ONE_OF_SIBLINGS) {
      if (sibling in node) errors.push(`${path}: oneOf cannot be combined with ${sibling}`);
    }
    if (!Array.isArray(node.oneOf)) errors.push(`${path}.oneOf: must be an array`);
    else if (node.oneOf.length < 2) errors.push(`${path}.oneOf: requires at least two variants`);
    else node.oneOf.forEach((variant, index) => checkSchemaNode(variant, `${path}.oneOf[${index}]`, errors, seen));
  } else if (!hasType) {
    const offending = NEEDS_TYPE.filter((key) => key in node);
    if (offending.length > 0) {
      errors.push(`${path}: requires type or oneOf (found ${offending.join(', ')})`);
    }
  }

  if ('properties' in node) {
    if (!isPlainObject(node.properties)) errors.push(`${path}.properties: must be an object`);
    else {
      for (const [name, child] of Object.entries(node.properties)) {
        checkSchemaNode(child, `${path}.properties.${name}`, errors, seen);
      }
    }
  }

  if ('required' in node) {
    const properties = isPlainObject(node.properties) ? node.properties : {};
    if (!Array.isArray(node.required)) errors.push(`${path}.required: must be an array`);
    else {
      for (const name of node.required) {
        if (typeof name !== 'string') errors.push(`${path}.required: entries must be strings`);
        else if (!Object.prototype.hasOwnProperty.call(properties, name)) {
          errors.push(`${path}.required: "${name}" is not a declared property`);
        }
      }
    }
  }

  if ('additionalProperties' in node && typeof node.additionalProperties !== 'boolean') {
    errors.push(`${path}.additionalProperties: must be a boolean`);
  }

  if ('items' in node) checkSchemaNode(node.items, `${path}.items`, errors, seen);

  if ('enum' in node) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) errors.push(`${path}.enum: must be a non-empty array`);
    else {
      for (const entry of node.enum) {
        if (!isScalar(entry)) errors.push(`${path}.enum: entries must be scalars`);
        else if (hasType && typeof node.type === 'string' && SCHEMA_TYPES.includes(node.type) && !matchesType(entry, node.type)) {
          errors.push(`${path}.enum: ${JSON.stringify(entry)} does not match type ${node.type}`);
        }
      }
    }
  }

  if ('const' in node && !isScalar(node.const)) errors.push(`${path}.const: must be a scalar`);

  return errors;
}

/** @returns {string[]} the violations (empty when the schema is accepted) */
export function validateSchema(schema) {
  return checkSchemaNode(schema, '$', [], new WeakSet());
}

/** Throw when the schema is not accepted by the harness dialect. */
export function assertSupportedJsonSchema(schema) {
  const errors = validateSchema(schema);
  if (errors.length > 0) {
    const error = new Error(`unsupported JSON Schema:\n  - ${errors.join('\n  - ')}`);
    error.name = 'JsonSchemaError';
    error.violations = errors;
    throw error;
  }
}

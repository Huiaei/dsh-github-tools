/**
 * A local reimplementation of the harness **author schema DSL** rules
 * (`parameterSchemaSpecToJsonSchema` in @deepseek-ai/dsh-tools).
 *
 * `defineTool({ parameters })` takes a property map, not raw JSON Schema, and
 * compiles it strictly: an unknown key, a missing `type`/`oneOf`, a `required`
 * that is not literally `true`, or an object node without an explicit boolean
 * `additionalProperties` is a hard error at registration time.
 *
 * Keeping the rules here means the generated parameter specs are checked in CI
 * without the harness installed.
 */

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'];
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null'];
const ALL_TYPES = [...SCALAR_TYPES, 'array', 'object', 'json'];

function isPlain(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkKeys(node, path, allowed, errors) {
  for (const key of Object.keys(node)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not supported by the unified schema DSL`);
  }
}

/**
 * @param {unknown} node a value schema
 * @param {string} path
 * @param {{allowRequired: boolean}} options
 * @param {string[]} errors
 */
function checkValueSchema(node, path, { allowRequired }, errors) {
  if (!isPlain(node)) {
    errors.push(`${path} must be a value schema object`);
    return;
  }
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])];
  if (Object.hasOwn(node, 'required') && node.required !== true) {
    errors.push(`${path}.required must be true when present`);
  }

  const hasType = Object.hasOwn(node, 'type');
  const hasOneOf = Object.hasOwn(node, 'oneOf');
  if (!hasType && !hasOneOf) {
    errors.push(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
    return;
  }
  if (hasType && hasOneOf) {
    errors.push(`${path} cannot declare both type and oneOf`);
    return;
  }

  if (hasOneOf) {
    checkKeys(node, path, [...authorKeys, 'oneOf'], errors);
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      errors.push(`${path}.oneOf must be an array of at least two value schemas`);
      return;
    }
    node.oneOf.forEach((branch, index) => checkValueSchema(branch, `${path}.oneOf[${index}]`, { allowRequired: false }, errors));
    return;
  }

  const type = node.type;
  if (!ALL_TYPES.includes(type)) {
    errors.push(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
    return;
  }

  if (type === 'json') {
    checkKeys(node, path, [...authorKeys, 'type'], errors);
    return;
  }

  if (type === 'object') {
    checkKeys(node, path, [...authorKeys, 'type', 'properties', 'additionalProperties'], errors);
    if (typeof node.additionalProperties !== 'boolean') {
      errors.push(`${path}.additionalProperties must be explicitly true or false`);
    }
    if (Object.hasOwn(node, 'properties')) {
      if (!isPlain(node.properties)) errors.push(`${path}.properties must be an object of value schemas`);
      else {
        for (const [name, child] of Object.entries(node.properties)) {
          checkValueSchema(child, `${path}.properties.${name}`, { allowRequired: true }, errors);
        }
      }
    }
    return;
  }

  if (type === 'array') {
    checkKeys(node, path, [...authorKeys, 'type', 'items'], errors);
    if (Object.hasOwn(node, 'items')) {
      checkValueSchema(node.items, `${path}.items`, { allowRequired: false }, errors);
    }
    return;
  }

  checkKeys(node, path, [...authorKeys, 'type', 'enum', 'const'], errors);
  if (Object.hasOwn(node, 'enum')) {
    if (!Array.isArray(node.enum) || node.enum.length === 0) {
      errors.push(`${path}.enum must be a non-empty array of scalar values`);
    } else {
      for (const entry of node.enum) {
        if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) {
          errors.push(`${path}.enum entries must be scalars`);
        }
      }
    }
  }
}

/**
 * @param {unknown} spec the value passed as `defineTool({ parameters })`
 * @returns {string[]} the violations (empty when the harness would accept it)
 */
export function validateParameterSpec(spec) {
  const errors = [];
  if (!isPlain(spec)) {
    errors.push('parameters must be a ParameterSchemaSpec object');
    return errors;
  }
  for (const [name, value] of Object.entries(spec)) {
    checkValueSchema(value, `parameters.${name}`, { allowRequired: true }, errors);
  }
  return errors;
}

export { ANNOTATION_KEYS, SCALAR_TYPES, ALL_TYPES };

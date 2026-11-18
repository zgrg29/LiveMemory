/**
 * A small JSON Schema (2020-12 subset) validator.
 *
 * The app has zero runtime dependencies, so the result schema is validated by
 * this module instead of a library. It supports exactly the keywords used by
 * `analysis-result-v1.schema.json`: type, const, enum, required, properties,
 * additionalProperties:false, items, minItems, maxItems, minLength, maxLength,
 * minimum, maximum, format date-time and oneOf.
 *
 * Every error carries a stable code, the exact JSON path and parameters so the
 * console can tell the user which field is wrong, why, and how to fix it.
 */

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const SCHEMA_LIMITS = Object.freeze({
  maxDepth: 24,
  maxNodes: 60000,
  maxStringLength: 100000,
  maxErrors: 200
});

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function joinPath(path, key) {
  return path ? `${path}.${key}` : String(key);
}

function childPath(path, index) {
  return `${path}[${index}]`;
}

function pushError(errors, path, code, params = {}) {
  if (errors.length < SCHEMA_LIMITS.maxErrors) errors.push({path, code, params});
}

/**
 * Structural pre-check independent of the schema: depth, node count and string
 * sizes. This runs before validation so a hostile 8 MB JSON cannot exhaust the
 * stack or memory.
 */
export function checkStructure(value) {
  const errors = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    pushError(errors, '', 'NOT_OBJECT');
    return errors;
  }
  let nodes = 0;
  const stack = [{value, depth: 0, path: ''}];
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > SCHEMA_LIMITS.maxNodes) {
      pushError(errors, current.path, 'TOO_COMPLEX', {limit: SCHEMA_LIMITS.maxNodes});
      break;
    }
    if (current.depth > SCHEMA_LIMITS.maxDepth) {
      pushError(errors, current.path, 'TOO_DEEP', {limit: SCHEMA_LIMITS.maxDepth});
      continue;
    }
    if (typeof current.value === 'string') {
      if (current.value.length > SCHEMA_LIMITS.maxStringLength) {
        pushError(errors, current.path, 'STRING_TOO_LONG', {limit: SCHEMA_LIMITS.maxStringLength});
      }
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({value: current.value[index], depth: current.depth + 1, path: childPath(current.path, index)});
      }
      continue;
    }
    if (current.value && typeof current.value === 'object') {
      for (const key of Object.keys(current.value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          pushError(errors, joinPath(current.path, key), 'FORBIDDEN_KEY', {key});
          continue;
        }
        stack.push({value: current.value[key], depth: current.depth + 1, path: joinPath(current.path, key)});
      }
    }
  }
  return errors;
}

function validateOneOf(schema, value, path, errors, depth) {
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  let matched = 0;
  let firstErrors = null;
  for (const branch of branches) {
    const branchErrors = [];
    validateNode(branch, value, path, branchErrors, depth + 1);
    if (branchErrors.length === 0) matched += 1;
    else if (!firstErrors) firstErrors = branchErrors;
  }
  if (matched === 0) {
    const first = firstErrors?.[0];
    if (first && first.code !== 'SCHEMA_TYPE') errors.push(first);
    else pushError(errors, path, 'SCHEMA_REF_SHAPE', {actual: typeOf(value)});
  } else if (matched > 1) {
    pushError(errors, path, 'SCHEMA_AMBIGUOUS', {});
  }
}

function validateNode(schema, value, path, errors, depth) {
  if (!schema || typeof schema !== 'object') return;
  if (depth > SCHEMA_LIMITS.maxDepth || errors.length >= SCHEMA_LIMITS.maxErrors) return;
  if (Array.isArray(schema.oneOf)) {
    validateOneOf(schema, value, path, errors, depth);
    return;
  }
  if (schema.const !== undefined && value !== schema.const) {
    pushError(errors, path, 'SCHEMA_CONST', {expected: schema.const, actual: value});
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    pushError(errors, path, 'SCHEMA_ENUM', {expected: schema.enum.join(', '), actual: String(value)});
    return;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((expected) => matchesType(value, expected))) {
      pushError(errors, path, 'SCHEMA_TYPE', {expected: types.join(' | '), actual: typeOf(value)});
      return;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      pushError(errors, path, 'SCHEMA_MIN_LENGTH', {min: schema.minLength, actual: value.length});
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      pushError(errors, path, 'SCHEMA_MAX_LENGTH', {max: schema.maxLength, actual: value.length});
    }
    if (schema.format === 'date-time' && (!DATE_TIME.test(value) || !Number.isFinite(Date.parse(value)))) {
      pushError(errors, path, 'SCHEMA_DATETIME', {actual: value.slice(0, 64)});
    }
    return;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      pushError(errors, path, 'SCHEMA_MINIMUM', {min: schema.minimum, actual: value});
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      pushError(errors, path, 'SCHEMA_MAXIMUM', {max: schema.maximum, actual: value});
    }
    return;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      pushError(errors, path, 'SCHEMA_MIN_ITEMS', {min: schema.minItems, actual: value.length});
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      pushError(errors, path, 'SCHEMA_MAX_ITEMS', {max: schema.maxItems, actual: value.length});
    }
    if (schema.items) {
      const limit = Math.min(value.length, 5000);
      for (let index = 0; index < limit; index += 1) {
        validateNode(schema.items, value[index], childPath(path, index), errors, depth + 1);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          pushError(errors, joinPath(path, key), 'SCHEMA_REQUIRED', {field: key});
        }
      }
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          pushError(errors, joinPath(path, key), 'SCHEMA_UNKNOWN_FIELD', {field: key});
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      validateNode(childSchema, value[key], joinPath(path, key), errors, depth + 1);
    }
  }
}

/**
 * Validate a parsed JSON value against a schema.
 * @returns {Array<{path:string, code:string, params:object}>}
 */
export function validateAgainstSchema(schema, value) {
  const errors = checkStructure(value);
  if (errors.length > 0) return errors;
  const collected = [];
  validateNode(schema, value, '', collected, 0);
  return collected;
}

export const __internal = {typeOf, matchesType, DATE_TIME};

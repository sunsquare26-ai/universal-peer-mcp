// Versions 1 through 8 and the two RFC 9562 variant bits, which is every UUID a peer can put in
// front of this. It used to stop at 5, and 7 is in use — a time-ordered id is what a modern
// generator produces — so a peer that answered with one made the tool that would have reported
// the answer fail its own output contract: `invalid_public_result`, for that messageId, on every
// call, with no cursor for `peer_wait` or a `peer_send` replay to get past it. `requireUuid` in
// src/core/limits.mjs already took 1 through 8, so the id was accepted at the door and refused on
// the way out; the two agree now. The check itself stays: what is not a UUID is still not one.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSERTIONS = new Set(["$ref", "type", "const", "enum", "allOf", "anyOf", "oneOf", "not", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "minItems", "maxItems", "items", "required", "properties", "additionalProperties"]);
const ANNOTATIONS = new Set(["$schema", "$defs", "$id", "$anchor", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const FORMATS = new Set(["uuid", "byte", "uri", "uri-template", "date", "date-time", "email"]);

export function validateSchema(schema, value, { root = schema } = {}) {
  assertSupportedSchema(schema, root);
  const errors = [];
  visit(schema, value, "$", root, errors);
  return { valid: errors.length === 0, errors };
}

export function projectSchema(schema, value, { root = schema } = {}) {
  assertSupportedSchema(schema, root);
  return project(schema, value, root);
}

function project(schema, value, root) {
  if (schema === true || schema === undefined) return value;
  if (schema === false) return undefined;
  if (typeof schema.$ref === "string") return project(resolveRef(root, schema.$ref), value, root);
  if (Array.isArray(value) && schema.items) return value.map((item) => project(schema.items, item, root));
  if (plain(value) && plain(schema.properties)) {
    const result = {};
    for (const [key, child] of Object.entries(schema.properties)) if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = project(child, value[key], root);
    return result;
  }
  return value;
}

function visit(schema, value, at, root, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) return errors.push(`${at}: schema rejected value`);
  if (typeof schema.$ref === "string") { visit(resolveRef(root, schema.$ref), value, at, root, errors); return; }
  if (schema.const !== undefined && !equal(value, schema.const)) errors.push(`${at}: const mismatch`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(item, value))) errors.push(`${at}: not in enum`);
  if (Array.isArray(schema.allOf)) for (const item of schema.allOf) visit(item, value, at, root, errors);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => validateSchema(item, value, { root }).valid)) errors.push(`${at}: no anyOf branch matched`);
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((item) => validateSchema(item, value, { root }).valid).length !== 1) errors.push(`${at}: oneOf match count was not one`);
  if (schema.not && validateSchema(schema.not, value, { root }).valid) errors.push(`${at}: forbidden schema matched`);
  const accepted = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (accepted.length && !accepted.some((type) => matchesType(type, value))) { errors.push(`${at}: expected ${accepted.join("|")}`); return; }
  if (typeof value === "string") {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${at}: shorter than minLength`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${at}: longer than maxLength`);
    if (typeof schema.pattern === "string" && !(new RegExp(schema.pattern, "u")).test(value)) errors.push(`${at}: pattern mismatch`);
    if (schema.format && !matchesFormat(schema.format, value)) errors.push(`${at}: invalid ${schema.format}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${at}: fewer than minItems`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${at}: more than maxItems`);
    if (schema.items) for (let index = 0; index < value.length; index += 1) visit(schema.items, value[index], `${at}[${index}]`, root, errors);
  }
  if (plain(value)) validateObject(schema, value, at, root, errors);
}

function validateObject(schema, value, at, root, errors) {
  const properties = plain(schema.properties) ? schema.properties : {};
  for (const key of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(value, key)) errors.push(`${at}.${key}: required`);
  for (const [key, child] of Object.entries(properties)) if (Object.prototype.hasOwnProperty.call(value, key)) visit(child, value[key], `${at}.${key}`, root, errors);
  const extras = Object.keys(value).filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
  if (schema.additionalProperties === false) for (const key of extras) errors.push(`${at}.${key}: additional property`);
  else if (plain(schema.additionalProperties)) for (const key of extras) visit(schema.additionalProperties, value[key], `${at}.${key}`, root, errors);
}

function assertSupportedSchema(schema, root, seen = new Set()) {
  if (schema === true || schema === false || schema === undefined) return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("invalid JSON Schema node");
  if (seen.has(schema)) return; seen.add(schema);
  for (const key of Object.keys(schema)) if (!ASSERTIONS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported JSON Schema keyword: ${key}`);
  if (schema.format && !FORMATS.has(schema.format)) throw new Error(`unsupported JSON Schema format: ${schema.format}`);
  if (schema.$ref) { const target = resolveRef(root, schema.$ref); if (!target) throw new Error(`unresolved JSON Schema reference: ${schema.$ref}`); assertSupportedSchema(target, root, seen); }
  for (const key of ["allOf", "anyOf", "oneOf"]) for (const child of schema[key] ?? []) assertSupportedSchema(child, root, seen);
  if (schema.not) assertSupportedSchema(schema.not, root, seen);
  if (schema.items) assertSupportedSchema(schema.items, root, seen);
  if (plain(schema.properties)) for (const child of Object.values(schema.properties)) assertSupportedSchema(child, root, seen);
  if (plain(schema.additionalProperties)) assertSupportedSchema(schema.additionalProperties, root, seen);
}
function resolveRef(root, ref) { if (!ref.startsWith("#/")) return null; return ref.slice(2).split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], root); }
function matchesFormat(format, value) {
  if (format === "uuid") return UUID.test(value);
  if (format === "byte") return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
  if (format === "uri") { try { return Boolean(new URL(value).protocol); } catch { return false; } }
  if (format === "uri-template") return value.length > 0 && !/[\u0000-\u0020]/u.test(value);
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === "date-time") return !Number.isNaN(Date.parse(value));
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  return false;
}
function matchesType(type, value) { if (type === "null") return value === null; if (type === "array") return Array.isArray(value); if (type === "object") return plain(value); if (type === "integer") return Number.isInteger(value); if (type === "number") return typeof value === "number" && Number.isFinite(value); return typeof value === type; }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function equal(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

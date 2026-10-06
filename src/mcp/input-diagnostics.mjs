import { validateSchema } from "./schema-validator.mjs";

// Only schema-owned property names and constraint labels leave this boundary. Unknown keys
// are caller-controlled, and may themselves contain credentials, so never echo them.
export function inputDiagnostic(tool, args) {
  if (!tool) return "unknown tool name";
  if (args === null || typeof args !== "object" || Array.isArray(args)) return "arguments must be an object";
  const checked = validateSchema(tool.inputSchema, args);
  if (checked.valid) return null;
  const properties = tool.inputSchema.properties ?? {};
  for (const issue of checked.errors) {
    const match = /^\$\.([A-Za-z][A-Za-z0-9]*): (required|invalid uuid|expected [a-z|]+|not in enum|pattern mismatch|shorter than minLength|longer than maxLength|below minimum|above maximum)$/.exec(issue);
    if (match && Object.hasOwn(properties, match[1])) return `${match[1]}: ${match[2]}`;
  }
  return "arguments do not match the tool schema (unknown fields are not allowed)";
}

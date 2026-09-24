import { zodToJsonSchema } from "zod-to-json-schema";
import type * as z from "zod";

/**
 * Converts a tool `params` schema into a plain JSON Schema object for the
 * wire. Accepts either a zod v3 schema (anything with a `_def`) or a plain
 * JSON-Schema-ish object (`{ type: "object", properties: {...} }`, passed
 * through untouched). Zod v4 is not supported.
 */
export function toJsonSchema(
  params: unknown,
  toolName: string,
): Record<string, unknown> {
  if (isPlainJsonSchema(params)) {
    return params;
  }
  if (isZodSchema(params)) {
    const { $schema: _dropped, ...schema } = zodToJsonSchema(params, {
      target: "jsonSchema7",
      $refStrategy: "none",
    }) as Record<string, unknown>;
    return schema;
  }
  throw new Error(
    `Tool "${toolName}": \`params\` must be a zod v3 schema or a plain JSON ` +
      `schema object (\`{ type: "object", properties: {...} }\`).`,
  );
}

type JsonSchemaObject = Record<string, unknown> & {
  type: "object";
  properties: Record<string, unknown>;
};

function isPlainJsonSchema(params: unknown): params is JsonSchemaObject {
  return (
    typeof params === "object" &&
    params !== null &&
    (params as { type?: unknown }).type === "object" &&
    typeof (params as { properties?: unknown }).properties === "object" &&
    (params as { properties?: unknown }).properties !== null
  );
}

function isZodSchema(params: unknown): params is z.ZodTypeAny {
  return (
    typeof params === "object" &&
    params !== null &&
    "_def" in params &&
    typeof (params as { _def?: unknown })._def === "object"
  );
}

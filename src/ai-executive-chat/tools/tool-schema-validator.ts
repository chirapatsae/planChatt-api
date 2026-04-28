import { ToolJsonSchema } from './executive-tool.types';

/**
 * Lightweight JSON-Schema validator covering the structural subset
 * declared in `executive-tool.types.ts`.
 *
 * Why not Ajv? The `backend/package.json` does not ship Ajv and the
 * tool registry only uses a tiny Draft-07 subset (`type`, `properties`,
 * `required`, `enum`, `items`, `minimum`, `maximum`, `format`,
 * `additionalProperties`). Writing the validator inline keeps the
 * dependency surface unchanged and gives us control over the error
 * shape emitted on schema drift (§17.9 — `AI_SCHEMA_DRIFT`).
 *
 * Caller contract:
 *   - `validate(schema, value)` returns `{ok:true}` on success OR
 *     `{ok:false, error:string}` on the first failure.
 *   - Unknown `format` strings are accepted (we only range-check UUID
 *     and date-time best-effort).
 *   - `additionalProperties: false` rejects extra keys. Default when
 *     absent is permissive.
 */

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

const UUID_RX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function validateAgainstSchema(
  schema: ToolJsonSchema,
  value: unknown,
  path = '$',
): ValidationResult {
  if (!schema || typeof schema !== 'object') {
    return { ok: true };
  }

  // null short-circuit: type === 'null' handled, else reject.
  if (value === null) {
    if (schema.type === 'null') return { ok: true };
    if (!schema.type) return { ok: true };
    return { ok: false, error: `${path}: expected ${schema.type}, got null` };
  }

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') {
        return { ok: false, error: `${path}: expected string` };
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return {
          ok: false,
          error: `${path}: value "${value}" not in enum`,
        };
      }
      if (schema.format === 'uuid' && !UUID_RX.test(value)) {
        return { ok: false, error: `${path}: not a UUID` };
      }
      if (schema.format === 'date-time') {
        const d = Date.parse(value);
        if (Number.isNaN(d)) {
          return { ok: false, error: `${path}: not an ISO date-time` };
        }
      }
      return { ok: true };
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, error: `${path}: expected ${schema.type}` };
      }
      if (schema.type === 'integer' && !Number.isInteger(value)) {
        return { ok: false, error: `${path}: expected integer` };
      }
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        return {
          ok: false,
          error: `${path}: below minimum ${schema.minimum}`,
        };
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        return {
          ok: false,
          error: `${path}: above maximum ${schema.maximum}`,
        };
      }
      if (schema.enum && !schema.enum.includes(value)) {
        return { ok: false, error: `${path}: not in enum` };
      }
      return { ok: true };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        return { ok: false, error: `${path}: expected boolean` };
      }
      return { ok: true };
    }
    case 'array': {
      if (!Array.isArray(value)) {
        return { ok: false, error: `${path}: expected array` };
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const childRes = validateAgainstSchema(
            schema.items,
            value[i],
            `${path}[${i}]`,
          );
          if (!childRes.ok) return childRes;
        }
      }
      return { ok: true };
    }
    case 'object':
    default: {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, error: `${path}: expected object` };
      }
      const obj = value as Record<string, unknown>;
      if (Array.isArray(schema.required)) {
        for (const requiredKey of schema.required) {
          if (!(requiredKey in obj)) {
            return {
              ok: false,
              error: `${path}: missing required key "${requiredKey}"`,
            };
          }
        }
      }
      if (schema.properties) {
        for (const [key, childSchema] of Object.entries(schema.properties)) {
          if (key in obj) {
            const childRes = validateAgainstSchema(
              childSchema,
              obj[key],
              `${path}.${key}`,
            );
            if (!childRes.ok) return childRes;
          }
        }
      }
      if (schema.additionalProperties === false) {
        const allowed = new Set(
          schema.properties ? Object.keys(schema.properties) : [],
        );
        for (const key of Object.keys(obj)) {
          if (!allowed.has(key)) {
            return {
              ok: false,
              error: `${path}: unexpected additional property "${key}"`,
            };
          }
        }
      }
      return { ok: true };
    }
  }
}

export function parseToolCallArguments(raw: string): {
  ok: boolean;
  value?: unknown;
  error?: string;
} {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return {
      ok: false,
      error: `invalid JSON in tool_call.arguments: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

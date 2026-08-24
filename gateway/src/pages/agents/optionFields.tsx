import { Checkbox, FormControlLabel, TextField } from "@mui/material";

interface JsonSchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  default?: unknown;
  // JSON-schema string format hint; "password" marks a secret field.
  format?: string;
  // Pydantic emits `str | None` as { anyOf: [{type:"string"}, {type:"null"}] }
  // instead of a top-level `type`. Inspect this when `type` is absent.
  anyOf?: { type?: string }[];
}

/** Whether a string field holds a secret and should be masked on input.
 *  Honors an explicit `format: "password"` and falls back to a name heuristic
 *  (token / password / secret / api key) so credentials are not shown plainly. */
export function isSecretField(
  key: string,
  prop: { format?: string },
): boolean {
  if (prop.format === "password") return true;
  return /token|password|secret|api[_-]?key/i.test(key);
}

/** Normalize a property's primitive type, looking through `anyOf` for nullable
 *  Pydantic fields (Optional[str], Optional[bool], …). Returns the first
 *  non-"null" type, or undefined if none match. */
function primitiveType(prop: JsonSchemaProperty): string | undefined {
  if (prop.type) return prop.type;
  if (prop.anyOf) {
    for (const variant of prop.anyOf) {
      if (variant.type && variant.type !== "null") return variant.type;
    }
  }
  return undefined;
}

interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaProperty>;
}

function asSchemaObject(
  schema: Record<string, unknown> | undefined,
): JsonSchemaObject | null {
  if (!schema || typeof schema !== "object") return null;
  return schema as JsonSchemaObject;
}

export function extractDefaults(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const obj = asSchemaObject(schema);
  if (!obj?.properties) return {};
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(obj.properties)) {
    if (prop.default !== undefined) out[key] = prop.default;
  }
  return out;
}

function humanizeKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Whether a value satisfies a required field. A blank string does not; `false`
 *  does — it is an answer, not an omission. */
export function isProvided(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return value !== undefined && value !== null;
}

export function renderOptionFields(
  schema: Record<string, unknown> | undefined,
  values: Record<string, unknown>,
  setValues: (
    update: (prev: Record<string, unknown>) => Record<string, unknown>,
  ) => void,
  // Marks a field with the usual asterisk. Optional because agent options have
  // no required fields; a bridge connection's credentials do.
  requiredFields: string[] = [],
) {
  const obj = asSchemaObject(schema);
  if (!obj?.properties) return null;
  return (
    <>
      {Object.entries(obj.properties).map(([key, prop]) => {
        const label = prop.title ?? humanizeKey(key);
        const kind = primitiveType(prop);
        if (kind === "boolean") {
          return (
            <FormControlLabel
              key={key}
              control={
                <Checkbox
                  checked={Boolean(values[key])}
                  onChange={(e) =>
                    setValues((prev) => ({
                      ...prev,
                      [key]: e.target.checked,
                    }))
                  }
                />
              }
              label={
                <>
                  {label}
                  {prop.description && (
                    <span
                      style={{
                        display: "block",
                        fontSize: "0.75rem",
                        opacity: 0.7,
                      }}
                    >
                      {prop.description}
                    </span>
                  )}
                </>
              }
            />
          );
        }
        if (kind === "string") {
          return (
            <TextField
              key={key}
              label={label}
              type={isSecretField(key, prop) ? "password" : "text"}
              value={(values[key] as string | undefined) ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [key]: e.target.value }))
              }
              fullWidth
              required={requiredFields.includes(key)}
              helperText={prop.description}
            />
          );
        }
        return null;
      })}
    </>
  );
}

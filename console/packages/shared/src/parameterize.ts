/**
 * Client-side transform that turns exported room YAML into a parameterized
 * template.  Replaces literal values with `{key}` placeholders and prepends a
 * `params:` block — the same grammar the server-side parser interpolates on
 * import (see `rooms_yaml.PLACEHOLDER_RE`).
 */

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ParamSubstitution = {
  /** Param name — must match `[A-Za-z_][A-Za-z0-9_]*`. */
  key: string;
  /** The literal value to replace with `{key}`. */
  value: string;
  /** Optional human description for the `params:` entry. */
  description?: string;
};

/**
 * Replace `substitutions` values with `{key}` placeholders throughout the YAML
 * text and prepend a `params:` block with each substitution's type and default.
 *
 * Longer values are replaced first so a value that is a substring of another
 * cannot steal its match.  After replacement, any YAML scalar value that now
 * contains a bare `{` is single-quoted so it survives `yaml.safe_load` (which
 * would otherwise parse `{word}` as a flow mapping).
 */
export function parameterize(yamlText: string, substitutions: ParamSubstitution[]): string {
  if (substitutions.length === 0) return yamlText;

  for (const s of substitutions) {
    if (!PARAM_NAME_RE.test(s.key)) {
      throw new Error(`Invalid param name: "${s.key}"`);
    }
    if (s.value === '') {
      throw new Error(`Empty value for param "${s.key}"`);
    }
  }

  // Check for duplicate keys.
  const seen = new Set<string>();
  for (const s of substitutions) {
    if (seen.has(s.key)) throw new Error(`Duplicate param key: "${s.key}"`);
    seen.add(s.key);
  }

  // Replace longest values first.
  const sorted = [...substitutions].sort((a, b) => b.value.length - a.value.length);

  let result = yamlText;
  for (const s of sorted) {
    result = result.split(s.value).join(`{${s.key}}`);
  }

  // Quote YAML scalars that now contain a bare `{`.
  result = quoteUnquotedBraces(result);

  // Build and prepend the params block.
  const paramsBlock = buildParamsBlock(substitutions);
  if (result.startsWith('room:')) {
    result = paramsBlock + result;
  } else {
    result = result.replace(/^(room:)/m, paramsBlock + '$1');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** YAML scalars dumped by Python's `yaml.dump(default_flow_style=False)` land
 * in one of two line shapes:
 *
 *   key: value        (mapping entry)
 *   - value           (sequence item)
 *
 * If `value` contains `{` and is not already quoted, wrap it in single quotes
 * so `yaml.safe_load` reads it as a string rather than a flow mapping.  Values
 * that are already single- or double-quoted, or that start a block scalar
 * (`|`, `>`), are left alone.
 */
function quoteUnquotedBraces(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      // mapping value: `  key: value`
      const kv = line.match(/^(\s*[^\s#][^:]*:\s+)(.+)$/);
      if (kv) {
        const [, prefix, val] = kv;
        if (needsQuoting(val)) return `${prefix}${singleQuote(val)}`;
        return line;
      }
      // sequence item: `  - value`
      const li = line.match(/^(\s*-\s+)(.+)$/);
      if (li) {
        const [, prefix, val] = li;
        if (needsQuoting(val)) return `${prefix}${singleQuote(val)}`;
        return line;
      }
      return line;
    })
    .join('\n');
}

function needsQuoting(val: string): boolean {
  if (!val.includes('{')) return false;
  if (val.startsWith("'") || val.startsWith('"')) return false;
  if (val === '|' || val === '>') return false;
  return true;
}

/** Single-quote a YAML scalar, escaping embedded single quotes by doubling. */
function singleQuote(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

function buildParamsBlock(subs: ParamSubstitution[]): string {
  const lines: string[] = ['params:'];
  for (const s of subs) {
    lines.push(`  ${s.key}:`);
    lines.push('    type: string');
    lines.push(`    default: ${yamlScalar(s.value)}`);
    if (s.description) {
      lines.push(`    description: ${yamlScalar(s.description)}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Emit a YAML scalar, quoting only when needed. */
function yamlScalar(val: string): string {
  if (val === '') return "''";
  // Quote if the value contains YAML-special characters.
  if (/[:{}[\],&*?|>'"%@`#!]/.test(val) || val.includes('\n')) {
    return singleQuote(val);
  }
  return val;
}

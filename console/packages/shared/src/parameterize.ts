/**
 * Turns exported room YAML into a parameterized template: literal values
 * become `{key}` placeholders and a `params:` block is prepended, in the
 * grammar the server interpolates on import (see `rooms_yaml.PLACEHOLDER_RE`).
 */

const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ParamSubstitution = {
  /** The param name, matching `[A-Za-z_][A-Za-z0-9_]*`. */
  key: string;
  /** The literal value to replace with `{key}`. */
  value: string;
  /** Optional human description for the `params:` entry. */
  description?: string;
};

/**
 * Replace `substitutions` values with `{key}` placeholders and prepend a
 * `params:` block with each substitution's type and default.
 *
 * Only scalar positions are touched: a mapping value, a mapping key (an
 * alias map is keyed by agent name), a sequence item, and the text of a
 * block scalar. The structure of the document is never a match, so a room
 * called `room` does not lose its `room:` key. Longer values are replaced
 * first so a value that is a substring of another cannot steal its match,
 * and a key or value that now holds a bare `{` is single-quoted so
 * `yaml.safe_load` reads it as text rather than a flow mapping.
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
  const substitute = (text: string) =>
    sorted.reduce((out, s) => out.split(s.value).join(`{${s.key}}`), text);

  let result = rewriteScalars(yamlText, substitute);

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

/**
 * Apply `substitute` to every scalar of a YAML document dumped by Python's
 * `yaml.dump(default_flow_style=False)`, whose lines come in these shapes:
 *
 *   key: value          (mapping entry)
 *   key: |              (block scalar header; the body is the lines below,
 *                        indented deeper, and is free text)
 *   - value             (sequence item)
 *   - key: value        (mapping entry inside a sequence item)
 *
 * A key or value that comes out holding a bare `{` is single-quoted. Keys
 * are names of the format, not text, so they are left alone except inside
 * an `aliases:` map, whose keys are agent names, and there a key is
 * substituted only as a whole.
 */
function rewriteScalars(text: string, substitute: (s: string) => string): string {
  // The indent of the `key: |` line whose block body is being walked, or
  // null outside a block.
  let blockIndent: number | null = null;
  // The indent of the `aliases:` line whose entries are being walked, or null.
  let aliasesIndent: number | null = null;
  return text
    .split('\n')
    .map((line) => {
      const indent = line.match(/^ */)?.[0].length ?? 0;
      if (blockIndent !== null) {
        if (line.trim() === '' || indent > blockIndent) return substitute(line);
        blockIndent = null;
      }
      const item = line.match(/^(\s*-\s+)(.*)$/);
      const prefix = item ? item[1] : '';
      const rest = item ? item[2] : line;
      if (aliasesIndent !== null && line.trim() !== '' && indent <= aliasesIndent) {
        aliasesIndent = null;
      }
      const kv = rest.match(/^(\s*)([^\s#'"][^:]*?|'[^']*'|"[^"]*")(:)(\s+(.*)|)$/);
      if (kv) {
        const [, lead, key, colon, tail, val] = kv;
        const inAliases = aliasesIndent !== null && indent > aliasesIndent;
        const newKey = inAliases ? substituteWhole(key, substitute) : key;
        if (key === 'aliases' && (val === undefined || val === '')) aliasesIndent = indent;
        if (val === undefined || val === '') return `${prefix}${lead}${newKey}${colon}${tail ?? ''}`;
        if (isBlockHeader(val)) {
          blockIndent = indent;
          return `${prefix}${lead}${newKey}${colon}${tail}`;
        }
        return `${prefix}${lead}${newKey}${colon} ${substituteScalar(val, substitute)}`;
      }
      if (item) return `${prefix}${substituteScalar(rest, substitute)}`;
      return line;
    })
    .join('\n');
}

/** A key is replaced only when it is exactly a value, and quoted if that leaves a `{`. */
function substituteWhole(key: string, substitute: (s: string) => string): string {
  const bare = key.replace(/^['"]|['"]$/g, '');
  const next = substitute(bare);
  if (next === bare) return key;
  return next.includes('{') ? singleQuote(next) : next;
}

/** A scalar is substituted inside its quotes when it has them, and quoted when a `{` appears in a bare one. */
function substituteScalar(val: string, substitute: (s: string) => string): string {
  const quoted = val.match(/^(['"])(.*)\1(\s*#.*)?$/);
  if (quoted) {
    const [, q, inner, comment] = quoted;
    const next = substitute(inner);
    return `${q}${q === "'" ? next.replace(/(?<!')'(?!')/g, "''") : next}${q}${comment ?? ''}`;
  }
  const next = substitute(val);
  return next.includes('{') ? singleQuote(next) : next;
}

/** `|`, `>`, and their chomping and indentation variants in either order (`|-`, `>+`, `|2`, `|2-`). */
function isBlockHeader(val: string): boolean {
  return /^[|>](?:[-+]?\d*|\d*[-+]?)$/.test(val.trim());
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

/**
 * Emit a YAML scalar, quoting when needed: special characters, and anything
 * the loader would read as something other than text (`true`, `null`, `001`,
 * `1.5`), so a default comes back as the string it was.
 */
function yamlScalar(val: string): string {
  if (val === '') return "''";
  if (/[:{}[\],&*?|>'"%@`#!]/.test(val) || val.includes('\n')) {
    return singleQuote(val);
  }
  if (/^(?:true|false|yes|no|on|off|null|~|[-+]?(?:\d[\d_]*)?(?:\.\d*)?(?:e[-+]?\d+)?|0x[0-9a-f]+|0o[0-7]+|[-+]?\.(?:inf|nan))$/i.test(val)) {
    return singleQuote(val);
  }
  if (val !== val.trim()) return singleQuote(val);
  return val;
}

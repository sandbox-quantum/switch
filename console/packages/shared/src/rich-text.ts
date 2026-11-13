/**
 * Inline rich text as plain JSON: a list of spans, each its text plus the
 * styles it carries. No blocks and no nesting, so it travels anywhere as data
 * and whatever displays it turns each span into one styled element.
 *
 *   [{ "text": "found at " }, { "text": "/usr/bin/claude", "code": true }]
 *
 * A flattened subset of Quill's Delta ops (`{ insert, attributes }`).
 * Write it with the `rich` tag rather than by hand:
 *
 *   rich`found at ${code(path)}`
 */
export type RichSpan = {
  text: string;
  code?: true;
  bold?: true;
  italic?: true;
};

export type RichText = RichSpan[];

/** What `rich` takes between `${}`: plain values become plain text. */
export type RichValue = RichSpan | RichText | string | number;

function spansOf(value: RichValue): RichSpan[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'object') return [value];
  return [{ text: String(value) }];
}

/** Builds rich text from a template: rich`Checking if ${code('claude')} exists`. */
export function rich(strings: TemplateStringsArray, ...values: RichValue[]): RichText {
  const spans: RichSpan[] = [];
  strings.forEach((text, i) => {
    spans.push({ text });
    if (i < values.length) spans.push(...spansOf(values[i]!));
  });
  return spans.filter((span) => span.text !== '');
}

export function code(text: string): RichSpan {
  return { text, code: true };
}

export function bold(text: string): RichSpan {
  return { text, bold: true };
}

export function italic(text: string): RichSpan {
  return { text, italic: true };
}

/** The text of `richText` without its styles. */
export function plainText(richText: RichText): string {
  return richText.map((span) => span.text).join('');
}

/** `parts` one under the other: joined with line breaks, which whatever displays it keeps. */
export function lines(...parts: RichText[]): RichText {
  return parts.flatMap((part, i) => (i === 0 ? part : [{ text: '\n' }, ...part]));
}

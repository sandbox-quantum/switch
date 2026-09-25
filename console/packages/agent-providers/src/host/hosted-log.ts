const REDACTED = Buffer.from('[REDACTED]');

/** Exact-value redaction that prefers the longest value when secrets overlap. */
export function redactHostedText(text: string, values: string[]): string {
  const secrets = [...new Set(values.filter(Boolean))]
    .map((value) => Buffer.from(value))
    .sort((left, right) => right.length - left.length);
  if (!secrets.length) return text;
  const input = Buffer.from(text);
  const parts: Buffer[] = [];
  let literalStart = 0;
  let cursor = 0;
  while (cursor < input.length) {
    const secret = secrets.find(
      (candidate) =>
        cursor + candidate.length <= input.length &&
        input.subarray(cursor, cursor + candidate.length).equals(candidate)
    );
    if (!secret) {
      cursor += 1;
      continue;
    }
    if (literalStart < cursor) parts.push(input.subarray(literalStart, cursor));
    parts.push(REDACTED);
    cursor += secret.length;
    literalStart = cursor;
  }
  if (literalStart < cursor) parts.push(input.subarray(literalStart, cursor));
  return Buffer.concat(parts).toString();
}

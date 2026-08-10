export const MAX_SESSION_NAME_LENGTH = 64;

type SessionNameTransformOptions = {
  preserveCapitalization?: boolean;
};

const applyCapitalization = (input: string, options?: SessionNameTransformOptions): string =>
  options?.preserveCapitalization ? input : input.toLowerCase();

export const liveTransformSessionName = (
  input: string,
  options?: SessionNameTransformOptions
): string =>
  applyCapitalization(input, options)
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .slice(0, MAX_SESSION_NAME_LENGTH);

export const normalizeSessionName = (
  input: string,
  options?: SessionNameTransformOptions
): string =>
  applyCapitalization(input, options)
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SESSION_NAME_LENGTH);

export const sessionNameCollisionKey = (input: string): string =>
  normalizeSessionName(input).toLowerCase();

export const ensureUniqueSessionName = (
  baseName: string,
  existingNames: Iterable<string>,
  maxAttempts = 6,
  options?: SessionNameTransformOptions
): string => {
  const normalizedExisting = new Set(
    Array.from(existingNames, (name) => sessionNameCollisionKey(name)).filter(Boolean)
  );
  const base = normalizeSessionName(baseName, options);
  if (base && !normalizedExisting.has(sessionNameCollisionKey(base))) return base;

  for (let i = 2; i < 2 + maxAttempts; i++) {
    const candidate = normalizeSessionName(`${baseName}-${i}`, options);
    if (candidate && !normalizedExisting.has(sessionNameCollisionKey(candidate))) {
      return candidate;
    }
  }

  const fallback = normalizeSessionName(`${baseName}-${Date.now().toString(36)}`, options);
  return fallback || base;
};

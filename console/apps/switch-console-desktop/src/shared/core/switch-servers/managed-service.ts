export function managedServiceOrigin(value: string | undefined): string {
  if (!value?.trim()) {
    throw new Error('Switch-managed sign-in is not configured in this build.');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('The managed service address is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'The managed service address must be an HTTPS origin without credentials, a path, or query parameters.'
    );
  }
  return url.origin;
}

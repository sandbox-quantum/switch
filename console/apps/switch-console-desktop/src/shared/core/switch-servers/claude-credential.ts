export type ClaudeCredentialKind = 'api-key' | 'setup-token';

export function validateClaudeCredential(kind: ClaudeCredentialKind, value: string): string {
  if (kind !== 'api-key' && kind !== 'setup-token') {
    throw new Error('Choose API key or subscription.');
  }
  const credential = value.trim();
  if (!credential || credential.length > 16 * 1024 || /[^\x21-\x7e]/.test(credential)) {
    throw new Error('Paste a single credential without spaces or line breaks.');
  }
  if (kind === 'api-key' && credential.startsWith('sk-ant-oat')) {
    throw new Error('This looks like a setup token. Choose Subscription instead.');
  }
  if (kind === 'setup-token' && !credential.startsWith('sk-ant-oat')) {
    throw new Error('Paste the setup token printed by claude setup-token.');
  }
  if (kind === 'api-key' && !credential.startsWith('sk-ant-api')) {
    throw new Error('Paste an API key created in Claude Console.');
  }
  return credential;
}

export type ClaudeConnection =
  | { status: 'not_connected' }
  | { status: 'connected'; kind: ClaudeCredentialKind; verified_at: string };

import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import {
  type ClaudeCredentialKind,
  validateClaudeCredential,
} from '@shared/core/switch-servers/claude-credential';

function secretKey(serverId: string): string {
  return `managed-claude-draft:${serverId}`;
}

export async function saveManagedClaudeCredential(
  serverId: string,
  kind: ClaudeCredentialKind,
  value: string
): Promise<void> {
  const credential = validateClaudeCredential(kind, value);
  await encryptedAppSecretsStore.setSecret(
    secretKey(serverId),
    JSON.stringify({ kind, credential })
  );
}

export async function deleteManagedClaudeCredential(serverId: string): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(secretKey(serverId));
}

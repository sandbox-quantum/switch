import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
function secretKey(serverId: string): string {
  return `managed-claude-draft:${serverId}`;
}

export async function deleteManagedClaudeCredential(serverId: string): Promise<void> {
  await encryptedAppSecretsStore.deleteSecret(secretKey(serverId));
}

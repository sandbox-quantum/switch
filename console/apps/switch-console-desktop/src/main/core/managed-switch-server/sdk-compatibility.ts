import { contractRange } from '@switch-console/shared';
import { fetchMe } from '@main/core/switch-servers/gateway-client';
import type {
  SwitchServer,
  SwitchServerDeclaration,
} from '@shared/core/switch-servers/switch-servers';

export function supportsSdkSessions(
  declaration: SwitchServerDeclaration | null | undefined
): boolean {
  const range = declaration?.contracts['sdk-sessions'];
  const client = contractRange('sdk-sessions', 'switch-console');
  return (
    !!range &&
    Number.isInteger(range.accepts) &&
    Number.isInteger(range.speaks) &&
    range.accepts >= 1 &&
    range.accepts <= range.speaks &&
    range.accepts <= client.speaks &&
    range.speaks >= client.accepts
  );
}

export async function verifySdkCompatibility(server: SwitchServer): Promise<void> {
  const user = await fetchMe(server);
  if (!supportsSdkSessions(user.server)) {
    throw new Error(
      `Update ${server.name} before starting sessions. This server does not support this app’s SDK sessions. ${server.managed ? 'Open the server page to update it.' : 'Ask the server owner to install a compatible Switch release.'}`
    );
  }
}

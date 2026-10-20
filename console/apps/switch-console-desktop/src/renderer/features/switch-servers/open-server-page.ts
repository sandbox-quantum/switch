import { toast } from 'sonner';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';

/**
 * Open one of a server's dashboard pages, and say why when it cannot be: the
 * server may not be reachable, or may not serve a dashboard at the address
 * Console has for it.
 */
export async function openServerPage(serverId: string, url: string): Promise<void> {
  try {
    await rpc.switchServers.openGatewayPage({ serverId, url });
  } catch (cause) {
    const { headline, detail } = describeFailure(cause, 'Could not open the dashboard.');
    toast.error(headline, detail ? { description: detail } : undefined);
  }
}

import { observer } from 'mobx-react-lite';
import {
  type GatewayCompatibility,
  THIS_CONSOLE,
  gatewayCompatibility,
} from '@shared/core/switch-servers/gateway-compatibility';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { TONE_BOX, ToneDot } from './managed-server-dot';
import { switchServersStore } from './switch-servers-store';

/** How a signed-in server and this Console stand on the gateway API, or null
 * while there is no session to read the server's declaration from. */
export function serverCompatibility(server: SwitchServer): GatewayCompatibility | null {
  const user = switchServersStore.statusFor(server.id)?.user ?? null;
  if (user === null) return null;
  return gatewayCompatibility(server.name, user.server, THIS_CONSOLE);
}

/** The active server when it and this Console do not speak a common revision
 * of the gateway API, with what is wrong; else null. */
export function incompatibleServer(): { message: string } | null {
  const server = switchServersStore.activeServer;
  if (!server) return null;
  const compatibility = serverCompatibility(server);
  if (compatibility?.kind === 'server-too-old' || compatibility?.kind === 'console-too-old') {
    return { message: compatibility.message };
  }
  return null;
}

/**
 * Across the top of the workspace when its server and this Console cannot work
 * together, saying which one to update. The workspace stays usable, since much
 * of it may still work, but calls that differ between the two will fail.
 */
export const GatewayCompatibilityBanner = observer(function GatewayCompatibilityBanner({
  message,
}: {
  message: string;
}) {
  return (
    <div
      role="alert"
      className={`flex shrink-0 items-center gap-3 border-b-[0.5px] px-4 py-2.5 ${TONE_BOX.failed}`}
    >
      <span className="flex w-3 shrink-0 justify-center">
        <ToneDot tone="failed" size={7} />
      </span>
      <p className="min-w-0 flex-1 text-[13px] text-foreground">{message}</p>
    </div>
  );
});

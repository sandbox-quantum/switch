import { z } from 'zod';
import type { OwnerNoticeList } from '@shared/core/switch-servers/owner-notice';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { GatewayError, gatewayFetch } from './gateway-client';

const ownerNoticeSchema = z.object({
  id: z.string(),
  kind: z.literal('unverified_agent_invite'),
  owner_id: z.string(),
  tenant_id: z.string(),
  agent_name: z.string(),
  room_name: z.string(),
  created_at: z.string(),
});

export async function fetchOwnerNotices(
  server: SwitchServer,
  expectedOwnerId: string,
  expectedTenantId: string
): Promise<OwnerNoticeList> {
  let response: Response;
  try {
    response = await gatewayFetch(server, '/owner-notices', { authenticated: true });
  } catch (error) {
    // The new list endpoint never returns 404 itself. Older gateways lack it.
    if (error instanceof GatewayError && error.status === 404) return { supported: false };
    throw error;
  }
  const received = z.array(ownerNoticeSchema).parse(await response.json());
  if (
    received.some(
      (notice) => notice.owner_id !== expectedOwnerId || notice.tenant_id !== expectedTenantId
    )
  ) {
    throw new Error('The signed-in account or workspace changed while loading notices.');
  }
  const notices = received.map((notice) => ({
    id: notice.id,
    kind: notice.kind,
    agentName: notice.agent_name,
    roomName: notice.room_name,
    createdAt: notice.created_at,
  }));
  return { supported: true, notices };
}

export async function dismissOwnerNotice(server: SwitchServer, noticeId: string): Promise<void> {
  await gatewayFetch(server, `/owner-notices/${encodeURIComponent(noticeId)}`, {
    authenticated: true,
    method: 'DELETE',
  });
}

import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';

/** Who a person is to their buddy: what it is named after and greets them by. */
export type BuddyPerson = { name: string | null; email: string | null };

/** The person signed in to the server, as the buddy knows them; nobody while unknown. */
export function buddyPerson(serverId: string): BuddyPerson {
  const user = switchServersStore.statusFor(serverId)?.user ?? null;
  return { name: user?.name ?? null, email: user?.email ?? null };
}

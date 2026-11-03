import type { ChatSummary } from '@shared/core/chats/chats';
import type { FeatureFlags } from '@shared/core/feature-flags/feature-flags';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';

/** The chat apps the setup cards walk through, by bridge type. */
export const BUDDY_PLATFORMS = ['slack', 'teams', 'telegram'] as const;
export type BuddyPlatform = (typeof BUDDY_PLATFORMS)[number];

export type BuddySetupStep =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'choose' }
  | { kind: 'connect'; platform: BuddyPlatform }
  | { kind: 'link'; bridge: RemoteBridge }
  | { kind: 'guide'; bridge: RemoteBridge }
  | { kind: 'resuming' }
  | { kind: 'create'; bridge: RemoteBridge }
  | { kind: 'done'; chat: ChatSummary };

/** Whether to show the setup cards: only when the server says so, since an older one would turn their resume into an internal chat. */
export function buddySetupCardsEnabled(flags: Partial<FeatureFlags> | null | undefined): boolean {
  return flags?.buddy_slack_handoff === true;
}

/** A hand-off resumed on one Slack connection: its chat, null for none started, or failed. */
export type BuddyResume = ChatSummary | null | 'failed';

/** The active Slack connections the person has linked, where a hand-off could have been made. */
export function buddyResumeBridges(
  bridges: RemoteBridge[] | null,
  identities: LinkedIdentity[] | null
): RemoteBridge[] {
  return (bridges ?? []).filter(
    (bridge) =>
      bridge.type === 'slack' &&
      bridge.status === 'active' &&
      identities?.some((identity) => identity.bridgeId === bridge.id)
  );
}

function activeBridge(bridges: RemoteBridge[] | null, platform: string) {
  return bridges?.find((bridge) => bridge.type === platform && bridge.status === 'active');
}

/** The app the cards are on: the one picked, else the first already connected. */
export function buddyPlatform(
  picked: BuddyPlatform | null,
  bridges: RemoteBridge[] | null
): BuddyPlatform | null {
  return picked ?? BUDDY_PLATFORMS.find((platform) => activeBridge(bridges, platform)) ?? null;
}

/**
 * Where the person is in moving their buddy to their chat app, from live reads. A read
 * not in yet is `loading`; one that failed is `unknown`, never "not connected".
 * Done only when resuming the hand-off on a connection, which never makes one,
 * found its chat: a Slack chat with the buddy made by hand is not a hand-off.
 * `resumes` is by bridge id, a bridge missing still being resumed.
 *
 * Only Slack gets a channel made for them: elsewhere, once linked, they are
 * told how to bring the buddy into a chat themselves. Every platform waits for
 * the link, since the buddy answers only its owner; on one with no directory
 * the link card says how to be seen there first.
 */
export function buddySetupStep({
  platform,
  bridges,
  identities,
  resumes,
  failed,
}: {
  platform: BuddyPlatform | null;
  bridges: RemoteBridge[] | null;
  identities: LinkedIdentity[] | null;
  resumes: Partial<Record<string, BuddyResume>>;
  failed: boolean;
}): BuddySetupStep {
  if (failed) return { kind: 'unknown' };
  if (!bridges) return { kind: 'loading' };
  if (!platform) return { kind: 'choose' };
  const first = activeBridge(bridges, platform);
  if (!first) return { kind: 'connect', platform };
  if (!identities) return { kind: 'loading' };
  if (platform !== 'slack') {
    const ready = bridges.find(
      (bridge) =>
        bridge.type === platform &&
        bridge.status === 'active' &&
        identities.some((identity) => identity.bridgeId === bridge.id)
    );
    return ready ? { kind: 'guide', bridge: ready } : { kind: 'link', bridge: first };
  }
  const linked = buddyResumeBridges(bridges, identities);
  if (linked.length === 0) return { kind: 'link', bridge: first };
  const results = linked.map((bridge) => resumes[bridge.id]);
  const chat = results.find(
    (result): result is ChatSummary => typeof result === 'object' && result !== null
  );
  if (chat) return { kind: 'done', chat };
  if (results.includes('failed')) return { kind: 'unknown' };
  if (results.includes(undefined)) return { kind: 'resuming' };
  return { kind: 'create', bridge: linked[0] };
}

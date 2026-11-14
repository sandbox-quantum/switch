import type { ChatSummary } from '@switch-console/chat-ui/contracts/chats';
import { chatFailure } from '@renderer/features/chats/chat-errors';
import type { FeatureFlags } from '@shared/core/feature-flags/feature-flags';
import type { LinkedIdentity, RemoteBridge } from '@shared/core/switch-servers/switch-servers';
import { RpcError } from '@shared/lib/ipc/rpc-error';

/** The chat apps the setup cards walk through, by bridge type. */
export const BUDDY_PLATFORMS = ['slack', 'teams', 'discord', 'telegram'] as const;
export type BuddyPlatform = (typeof BUDDY_PLATFORMS)[number];

/** The apps where the buddy makes the person a private channel; elsewhere they invite it themselves. */
const CHANNEL_PLATFORMS: readonly string[] = ['slack', 'discord'];

export type BuddySetupStep =
  | { kind: 'loading' }
  | { kind: 'unknown' }
  | { kind: 'choose' }
  | { kind: 'connect'; platform: BuddyPlatform }
  | { kind: 'link'; bridge: RemoteBridge }
  | { kind: 'guide'; bridge: RemoteBridge }
  | { kind: 'resuming' }
  | { kind: 'create'; bridge: RemoteBridge }
  | { kind: 'refused'; bridge: RemoteBridge; refusal: BuddyRefusal }
  | { kind: 'done'; chat: ChatSummary };

/** Whether to show the setup cards: only when the server says so, since an older one would turn their resume into an internal chat. */
export function buddySetupCardsEnabled(flags: Partial<FeatureFlags> | null | undefined): boolean {
  return flags?.buddy_slack_handoff === true;
}

/**
 * A hand-off the server refused for the person's linked accounts: more than
 * one on the bridge, or not the one it was started for. Its message is the
 * server's own, written for the person.
 */
export type BuddyRefusal = {
  code: 'ACCOUNTS_AMBIGUOUS' | 'LINKED_ACCOUNT_CHANGED';
  message: string;
};

const REFUSAL_CODES: readonly string[] = ['ACCOUNTS_AMBIGUOUS', 'LINKED_ACCOUNT_CHANGED'];

/** The linked-account refusal in a failed hand-off or resume, else null. */
export function buddyHandoffRefusal(cause: unknown): BuddyRefusal | null {
  if (!(cause instanceof RpcError) || cause.code !== 'ChatApiError') return null;
  const code = cause.stringField('apiCode');
  if (!code || !REFUSAL_CODES.includes(code)) return null;
  return { code: code as BuddyRefusal['code'], message: chatFailure(cause).message };
}

/** A hand-off resumed on one connection: its chat, null for none started, refused, or failed. */
export type BuddyResume = ChatSummary | null | BuddyRefusal | 'failed';

/** The active Slack and Discord connections the person has linked, where a hand-off could have been made. */
export function buddyResumeBridges(
  bridges: RemoteBridge[] | null,
  identities: LinkedIdentity[] | null
): RemoteBridge[] {
  return (bridges ?? []).filter(
    (bridge) =>
      CHANNEL_PLATFORMS.includes(bridge.type) &&
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

/** The app a hand-off was already made in: null for none, undefined while any resume is still out. */
export function buddyHandedOffPlatform(
  resumeBridges: RemoteBridge[],
  resumes: Partial<Record<string, BuddyResume>>
): BuddyPlatform | null | undefined {
  if (resumeBridges.some((bridge) => resumes[bridge.id] === undefined)) return undefined;
  return (
    (resumeBridges.find((bridge) => isChat(resumes[bridge.id]))?.type as BuddyPlatform) ?? null
  );
}

/**
 * The connection of the app the cards are on: the one chosen, else the one a
 * hand-off was made on, else a linked one, else the first connected.
 */
export function buddyBridge(
  platform: BuddyPlatform,
  bridges: RemoteBridge[] | null,
  identities: LinkedIdentity[] | null,
  resumes: Partial<Record<string, BuddyResume>>,
  chosenId: string | null
): RemoteBridge | undefined {
  const active = (bridges ?? []).filter(
    (bridge) => bridge.type === platform && bridge.status === 'active'
  );
  return (
    active.find((bridge) => bridge.id === chosenId) ??
    active.find((bridge) => isChat(resumes[bridge.id])) ??
    active.find((bridge) => identities?.some((identity) => identity.bridgeId === bridge.id)) ??
    active[0]
  );
}

function isChat(resume: BuddyResume | undefined): resume is ChatSummary {
  return typeof resume === 'object' && resume !== null && 'roomId' in resume;
}

/**
 * Where the person is in moving their buddy to their chat app, from live reads,
 * on one connection of it (see `buddyBridge`). A read not in yet is `loading`;
 * one that failed is `unknown`, never "not connected".
 * Done only when resuming the hand-off on a connection, which never makes one,
 * found its chat: a chat with the buddy made by hand is not a hand-off.
 * `resumes` is by bridge id, a bridge missing still being resumed. With no
 * connection chosen, every resume is waited for, so one already handed off wins.
 *
 * Only Slack and Discord get a channel made for them: elsewhere, once linked, they are
 * told how to bring the buddy into a chat themselves. Every platform waits for
 * the link, since the buddy answers only its owner; on one with no directory
 * the link card says how to be seen there first.
 */
export function buddySetupStep({
  platform,
  bridges,
  identities,
  resumes,
  chosenBridgeId,
  failed,
}: {
  platform: BuddyPlatform | null;
  bridges: RemoteBridge[] | null;
  identities: LinkedIdentity[] | null;
  resumes: Partial<Record<string, BuddyResume>>;
  chosenBridgeId: string | null;
  failed: boolean;
}): BuddySetupStep {
  if (failed) return { kind: 'unknown' };
  if (!bridges) return { kind: 'loading' };
  if (!platform) return { kind: 'choose' };
  const bridge = buddyBridge(platform, bridges, identities, resumes, chosenBridgeId);
  if (!bridge) return { kind: 'connect', platform };
  if (!identities) return { kind: 'loading' };
  if (!identities.some((identity) => identity.bridgeId === bridge.id))
    return { kind: 'link', bridge };
  if (!CHANNEL_PLATFORMS.includes(platform)) return { kind: 'guide', bridge };
  if (bridge.id !== chosenBridgeId && !isChat(resumes[bridge.id])) {
    const results = buddyResumeBridges(bridges, identities)
      .filter((linked) => linked.type === platform)
      .map((linked) => resumes[linked.id]);
    if (results.includes('failed')) return { kind: 'unknown' };
    if (results.includes(undefined)) return { kind: 'resuming' };
  }
  const resume = resumes[bridge.id];
  if (resume === 'failed') return { kind: 'unknown' };
  if (resume === undefined) return { kind: 'resuming' };
  if (resume === null) return { kind: 'create', bridge };
  return isChat(resume)
    ? { kind: 'done', chat: resume }
    : { kind: 'refused', bridge, refusal: resume };
}

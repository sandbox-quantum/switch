import { expect } from "vitest";
import {
  SwitchHttpError,
  errorDetail,
  sleep,
  type OpenStream,
  type StreamEnd,
  type SwitchClient,
} from "../clients/switch-client.ts";
import type { NameScope } from "../core/run.ts";
import type { Fixtures } from "../fixtures/fixtures.ts";
import type { FastScenario } from "./scenario.ts";

const ERASURE_DEADLINE_MS = 60_000;
const HISTORY_DEADLINE_MS = 30_000;

async function status(call: () => Promise<unknown>): Promise<[number, string]> {
  try {
    await call();
  } catch (error) {
    if (error instanceof SwitchHttpError) return [error.status, errorDetail(error.body)];
    throw error;
  }
  return [200, ""];
}

/**
 * A plain user in the harness admin's workspace, signed in, with their
 * account deleted afterwards. Deleting an account takes the deployment
 * operator, so the scenarios using this run only on a throwaway stack.
 */
async function colleague(
  role: string,
  names: NameScope,
  switchClient: SwitchClient,
  fixtures: Fixtures,
): Promise<{ id: string; name: string; email: string; password: string; client: SwitchClient }> {
  const password = `e2e-${names.runId}-${crypto.randomUUID()}`;
  const name = names.name(role);
  const email = `${name}@e2e.invalid`;
  const { id } = await switchClient.createUser({ name, email, password, role: "user" });
  fixtures.defer(`the account ${email}`, async () => {
    const [code, detail] = await status(() => switchClient.deleteUser(id));
    if (code !== 200 && code !== 404) throw new Error(`${code}: ${detail}`);
  });
  const client = switchClient.as(email, password);
  // Signing in joins the default workspace.
  await client.tenantId();
  return { id, name, email, password, client };
}

/**
 * A workspace admin sets how long messages are kept, sees beforehand how many
 * a window would delete, reads the window back and clears it. A plain member
 * may not set one.
 *
 * The window is set in a workspace made for the run and deleted afterwards
 * (which takes its retention policy with it), so no real workspace's policy
 * is ever touched. Whether old messages are then deleted is left to core's
 * tests: the retention pass runs hourly and the harness cannot age a message.
 */
export const retentionWindow: FastScenario = {
  header: {
    id: "retention-window",
    covers: [
      "GET /gateway/tenants/{tenant_id}/retention",
      "GET /gateway/tenants/{tenant_id}/retention/preview",
      "PUT /gateway/tenants/{tenant_id}/retention",
      "DELETE /gateway/tenants/{tenant_id}/retention",
    ],
    lane: "fast",
    environments: ["ephemeral"],
    owner: "platform",
    requires: [],
  },
  async run({ names, switchClient, fixtures }) {
    const member = await colleague("member", names, switchClient, fixtures);
    const defaultWorkspace = await switchClient.tenantId();
    const [memberSets] = await status(() =>
      member.client.setRetention(defaultWorkspace, 3650),
    );
    expect(memberSets, "a plain member setting a retention window").toBe(403);

    const makerPassword = `e2e-${names.runId}-${crypto.randomUUID()}`;
    const makerEmail = `${names.name("keeper")}@e2e.invalid`;
    // A deployment operator, so they can make a workspace. An operator's
    // account cannot be deleted, so it stays on the throwaway stack.
    await switchClient.createUser({
      name: "E2E retention keeper",
      email: makerEmail,
      password: makerPassword,
      role: "admin",
    });
    const maker = switchClient.as(makerEmail, makerPassword);
    const spaceName = names.name("kept");
    const spaceId = await maker.createTenant(spaceName);
    fixtures.defer(`the workspace ${spaceName}`, async () => {
      const [code, detail] = await status(() => maker.deleteTenant(spaceId, spaceName));
      if (code !== 200 && code !== 404) throw new Error(`${code}: ${detail}`);
    });

    expect(
      (await maker.retentionPolicy(spaceId)).message_retention_days,
      "a new workspace's window",
    ).toBeNull();

    const preview = await maker.previewRetention(spaceId, 30);
    expect(preview, "the preview of a 30-day window").toMatchObject({
      message_retention_days: 30,
      messages_to_delete: 0,
    });

    const set = await maker.setRetention(spaceId, 30);
    expect(set.message_retention_days, "the window just set").toBe(30);
    expect(set.updated_at, "when it was set").not.toBeNull();
    expect(
      (await maker.retentionPolicy(spaceId)).message_retention_days,
      "the window read back",
    ).toBe(30);

    const [tooLong] = await status(() => maker.setRetention(spaceId, 3651));
    expect(tooLong, "a window over ten years").toBe(422);

    const cleared = await maker.clearRetention(spaceId);
    expect(cleared.message_retention_days, "the cleared window").toBeNull();
    expect(
      (await maker.retentionPolicy(spaceId)).message_retention_days,
      "the window after clearing",
    ).toBeNull();
  },
};

/**
 * A workspace admin erases what a person sent from Switch Console. A
 * colleague chats with an agent; the admin finds them in the workspace's
 * people, queues their erasure and waits for it to finish, after which the
 * agent's history of that chat no longer holds their words. A plain member
 * may not see the list or erase anyone.
 *
 * @property retention.erasure-complete
 */
export const memberErasure: FastScenario = {
  header: {
    id: "member-erasure",
    covers: [
      "POST /gateway/chats",
      "POST /gateway/chats/{room_id}/messages",
      "GET /gateway/tenants/{tenant_id}/people",
      "POST /gateway/tenants/{tenant_id}/erasures",
      "GET /gateway/tenants/{tenant_id}/erasures",
    ],
    lane: "fast",
    environments: ["ephemeral"],
    owner: "platform",
    requires: [],
  },
  async run({ names, switchClient, fixtures }) {
    const agent = await fixtures.agent("listener");
    const person = await colleague("talker", names, switchClient, fixtures);
    const tenantId = await switchClient.tenantId();

    const roomId = await person.client.createDirectChat(agent.id);
    fixtures.defer(`the chat ${roomId}`, async () => {
      const [code, detail] = await status(() => switchClient.deleteRoom(roomId));
      if (code !== 200 && code !== 404) throw new Error(`${code}: ${detail}`);
    });
    const marker = names.marker("erase");
    const said = [`${marker} first`, `${marker} second`];
    for (const body of said) await person.client.sendChatMessage(roomId, body);

    const heard = async (): Promise<string[]> =>
      (await switchClient.roomHistory(agent, roomId, 50))
        .map((event) => event.body)
        .filter((body) => body.includes(marker));
    let before: string[] = [];
    const until = Date.now() + HISTORY_DEADLINE_MS;
    while (Date.now() < until) {
      before = await heard();
      if (before.length === said.length) break;
      await sleep(500);
    }
    expect(before, "what the colleague said, in the agent's history").toEqual(said);

    const [memberLists] = await status(() => person.client.people(tenantId));
    expect(memberLists, "a plain member listing the people to erase").toBe(403);

    const people = await switchClient.people(tenantId);
    const row = people.find((p) => p.kind === "member" && p.username === person.name);
    expect(row, `${person.name} among the workspace's people`).toBeDefined();
    expect(row!.platform).toBe("switch");
    expect(row!.message_count).toBeGreaterThanOrEqual(said.length);

    const [memberErases] = await status(() =>
      person.client.requestErasure(tenantId, { memberClientIds: [row!.id] }),
    );
    expect(memberErases, "a plain member erasing someone").toBe(403);

    const queued = await switchClient.requestErasure(tenantId, {
      memberClientIds: [row!.id],
    });
    expect(["queued", "running", "done"]).toContain(queued.state);

    let finished = queued;
    const deadline = Date.now() + ERASURE_DEADLINE_MS;
    while (finished.state !== "done" && finished.state !== "failed" && Date.now() < deadline) {
      await sleep(1_000);
      const current = (await switchClient.erasures(tenantId)).find((e) => e.id === queued.id);
      expect(current, "the queued erasure in the workspace's list").toBeDefined();
      finished = current!;
    }
    expect(finished.error, "the erasure's error").toBeNull();
    expect(finished.state, "the erasure's state").toBe("done");
    expect(finished.messages_deleted).toBeGreaterThanOrEqual(said.length);

    expect(await heard(), "what the colleague said, after the erasure").toEqual([]);
  },
};

/**
 * Signing out of every device. A person signed in twice ends all their
 * sessions from one: both cookies stop working, and signing in again works.
 * The deployment operator does the same for someone else; a plain member may
 * not.
 */
export const endSessions: FastScenario = {
  header: {
    id: "end-sessions",
    covers: [
      "POST /gateway/auth/sessions/revoke",
      "POST /gateway/users/{user_id}/sessions/revoke",
    ],
    lane: "fast",
    environments: ["ephemeral"],
    owner: "platform",
    requires: [],
  },
  async run({ names, switchClient, fixtures }) {
    const person = await colleague("traveller", names, switchClient, fixtures);
    const laptop = person.client;
    const phone = switchClient.as(person.email, person.password);
    await phone.tenantId();

    await laptop.endMySessions();
    const [laptopAfter] = await status(() => laptop.tenantId());
    expect(laptopAfter, "the session that ended them all").toBe(401);
    const [phoneAfter] = await status(() => phone.tenantId());
    expect(phoneAfter, "the other device's session").toBe(401);
    const again = switchClient.as(person.email, person.password);
    await again.tenantId();

    const other = await colleague("bystander", names, switchClient, fixtures);
    const [notOperator] = await status(() => again.endUserSessions(other.id));
    expect(notOperator, "a plain member ending someone's sessions").toBe(403);
    await other.client.tenantId();

    await switchClient.endUserSessions(person.id);
    const [revoked] = await status(() => again.tenantId());
    expect(revoked, "a session the operator ended").toBe(401);
    const [stillIn] = await status(() => other.client.tenantId());
    expect(stillIn, "someone else's session, untouched").toBe(200);

    const [nobody] = await status(() => switchClient.endUserSessions(crypto.randomUUID()));
    expect(nobody, "ending the sessions of no such user").toBe(404);
  },
};

const CHAT_EVENTS = "/gateway/chats/events";
const CHAT_ACTIVITY = "/gateway/chats/activity/events";
const CHANGE_SOCKET = "/gateway/changes/ws";
/** The change socket re-checks its session every 25s and the chat streams every 30s. */
const STREAM_CLOSE_DEADLINE_MS = 60_000;
const SOCKET_SESSION_ENDED = 4401;

async function endsWithin(what: string, stream: OpenStream): Promise<StreamEnd> {
  const deadline = sleep(STREAM_CLOSE_DEADLINE_MS).then((): never => {
    throw new Error(
      `${what} was still open ${STREAM_CLOSE_DEADLINE_MS / 1000}s after the sessions ended`,
    );
  });
  return Promise.race([stream.ended, deadline]);
}

async function streamsOf(client: SwitchClient): Promise<Record<string, OpenStream>> {
  return {
    [CHAT_EVENTS]: await client.openEventStream(CHAT_EVENTS),
    [CHAT_ACTIVITY]: await client.openEventStream(CHAT_ACTIVITY),
    [CHANGE_SOCKET]: await client.openChangeSocket(),
  };
}

async function expectAllClosed(
  device: string,
  client: SwitchClient,
  streams: Record<string, OpenStream>,
): Promise<void> {
  const ends = await Promise.all(
    Object.entries(streams).map(
      async ([path, stream]) => [path, await endsWithin(`${device}'s ${path}`, stream)] as const,
    ),
  );
  for (const [path, end] of ends) {
    expect(end.by, `who ended ${device}'s ${path}`).toBe("server");
    if (path === CHANGE_SOCKET) {
      expect(end.code, `${device}'s ${path} close code`).toBe(SOCKET_SESSION_ENDED);
    }
  }
  const reopen = [
    ["GET", CHAT_EVENTS],
    ["GET", CHAT_ACTIVITY],
    ["WS", CHANGE_SOCKET],
  ] as const;
  for (const [method, path] of reopen) {
    const { status: reopened } = await client.statusWithSession(method, path);
    expect(reopened, `${device} reopening ${path} with the ended session`).toBe(401);
  }
}

/**
 * Ending a person's sessions closes the streams those sessions hold open:
 * the chat event and activity streams and the change socket, on every
 * device, and reopening one with an ended session is refused. The streams
 * re-check their session on a timer, so each closes within one period of the
 * sessions ending. Someone else's socket stays open throughout. Covers both
 * ways sessions are ended on purpose: a person signing out of every device,
 * and the operator doing it for them.
 *
 * @property chats.streams-close-on-sign-out
 */
export const streamsCloseOnSignOut: FastScenario = {
  header: {
    id: "streams-close-on-sign-out",
    covers: [
      `GET ${CHAT_EVENTS}`,
      `GET ${CHAT_ACTIVITY}`,
      `WS ${CHANGE_SOCKET}`,
      "POST /gateway/auth/sessions/revoke",
      "POST /gateway/users/{user_id}/sessions/revoke",
    ],
    lane: "fast",
    environments: ["ephemeral"],
    owner: "platform",
    requires: [],
  },
  async run({ names, switchClient, fixtures }) {
    const person = await colleague("streamer", names, switchClient, fixtures);
    const bystander = await colleague("onlooker", names, switchClient, fixtures);
    const onlooking = await bystander.client.openChangeSocket();

    const laptop = person.client;
    const phone = switchClient.as(person.email, person.password);
    const laptopStreams = await streamsOf(laptop);
    const phoneStreams = await streamsOf(phone);
    await laptop.endMySessions();
    await Promise.all([
      expectAllClosed("the laptop", laptop, laptopStreams),
      expectAllClosed("the other device", phone, phoneStreams),
    ]);

    const again = switchClient.as(person.email, person.password);
    const againStreams = await streamsOf(again);
    await switchClient.endUserSessions(person.id);
    await expectAllClosed("a device the operator signed out", again, againStreams);

    const early = await Promise.race([onlooking.ended, sleep(0).then(() => null)]);
    expect(early, "how someone else's change socket ended, while it should be open").toBeNull();
    onlooking.close();
    expect((await onlooking.ended).by, "who ended someone else's change socket").toBe("client");
  },
};

import { expect } from 'vitest';
import { browserHeader, type BrowserScenario } from './scenario.ts';

/** The login form signs the admin in, and the app opens on the rooms list. */
const signIn: BrowserScenario = {
  header: browserHeader('gateway-sign-in', [
    'GET /gateway/auth/config',
    'POST /gateway/auth/login',
    'GET /gateway/auth/session',
  ]),
  async run({ ui }) {
    await ui.signIn();
    await expect
      .poll(() => ui.page.getByRole('heading', { name: 'Rooms', level: 5 }).isVisible())
      .toBe(true);
    await ui.settled();
  },
};

/**
 * Every page in the navigation rail opens without an error: each link the
 * signed-in admin is shown, so a page added to the rail is visited without
 * this list changing.
 */
const everyPage: BrowserScenario = {
  header: browserHeader('gateway-every-page', ['GET /gateway/rooms', 'GET /gateway/agents']),
  async run({ ui, log }) {
    await ui.signIn();
    const links = await ui.navLinks();
    expect(links.map((link) => link.path)).toEqual(expect.arrayContaining(['/rooms', '/agents']));
    for (const link of links) {
      await ui.nav().getByRole('link', { name: link.label }).click();
      await expect.poll(() => ui.path()).toBe(link.path);
      await ui.settled();
      log(`${link.label} (${link.path}) opened`);
    }
  },
};

/** A room made over the API is listed, and its page opens from the list. */
const roomFromList: BrowserScenario = {
  header: browserHeader('gateway-room-from-list', ['GET /gateway/rooms/{room_id}']),
  async run({ ui, fixtures }) {
    const agent = await fixtures.agent('member');
    const room = await fixtures.internalRoom('room', [agent]);
    await ui.signIn();
    const row = ui.page.getByRole('row').filter({ hasText: room.name });
    await expect.poll(() => row.count(), { timeout: 15_000 }).toBe(1);
    await row.click();
    await expect.poll(() => ui.path()).toBe(`/rooms/${room.id}`);
    await expect
      .poll(() => ui.page.getByRole('heading', { name: room.name }).isVisible())
      .toBe(true);
    await ui.settled();
  },
};

/**
 * A room made in the gateway's own form exists in the backend as asked: an
 * internal room (no bridge, so no platform channel is made on a shared
 * deployment) with the agent picked in the form as its member.
 */
const createRoom: BrowserScenario = {
  header: browserHeader('gateway-create-room', ['POST /gateway/rooms']),
  async run({ ui, fixtures, names, switchClient, log }) {
    const agent = await fixtures.agent('member');
    const name = names.name('ui-room');
    const description = `Made in the gateway form by the Switch end-to-end harness (run ${names.runId}). Safe to delete.`;
    await ui.signIn();
    await ui.page.getByRole('button', { name: 'New room' }).click();
    await expect.poll(() => ui.path()).toBe('/rooms/new');
    await ui.page.getByRole('textbox', { name: /^Name/ }).fill(name);
    await ui.page.getByRole('textbox', { name: /^Description/ }).fill(description);
    await ui.page.getByRole('combobox', { name: 'Agents' }).fill(agent.name);
    await ui.page.getByRole('option').filter({ hasText: agent.name }).click();
    // The room is known from the create call's answer, not from where the page
    // goes next, so it is removed even if the page never gets there.
    const created = ui.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/gateway/rooms'),
      { timeout: 15_000 }
    );
    await ui.page.getByRole('button', { name: 'Create', exact: true }).click();
    const response = await created;
    expect(response.status(), 'the create call failed').toBeLessThan(300);
    const roomId = ((await response.json()) as { id?: unknown }).id;
    if (typeof roomId !== 'string') {
      throw new Error(`the create call answered without a room id: ${await response.text()}`);
    }
    fixtures.defer(`room ${name} (${roomId})`, () => switchClient.deleteRoom(roomId));
    log(`created room ${name} (${roomId}) from the form`);
    await expect.poll(() => ui.path(), { timeout: 15_000 }).toBe(`/rooms/${roomId}`);

    const room = await switchClient.getRoom(roomId);
    expect(room.name).toBe(name);
    expect(room.bridgeId, 'the room was asked for with no bridge').toBeNull();
    expect(room.externalChannelId).toBeNull();
    expect(room.agentIds).toEqual([agent.id]);
    await expect.poll(() => ui.page.getByRole('heading', { name }).isVisible()).toBe(true);
    await ui.settled();
  },
};

/** Signing out ends the session: the app returns to the login form and stays there. */
const signOut: BrowserScenario = {
  header: browserHeader('gateway-sign-out', ['POST /gateway/auth/logout']),
  async run({ ui }) {
    await ui.signIn();
    await ui.signOut();
    await ui.goto('/rooms');
    await expect.poll(() => ui.path(), { timeout: 15_000 }).toBe('/login');
  },
};

/** Every browser-lane scenario. A scenario not listed here does not run. */
export const BROWSER_SCENARIOS: readonly BrowserScenario[] = [
  signIn,
  everyPage,
  roomFromList,
  createRoom,
  signOut,
];

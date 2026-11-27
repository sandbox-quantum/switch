import { expect } from 'vitest';
import { FULL_WINDOW } from '../../../../gateway/src/routes/roleMatrix.ts';
import { ROLE_MATRIX_SCENARIOS } from './role-matrix/index.ts';
import { browserHeader, type BrowserScenario } from './scenario.ts';

/** The login form signs the admin in, and the app opens on Home. */
const signIn: BrowserScenario = {
  header: browserHeader('gateway-sign-in', [
    'GET /gateway/auth/config',
    'POST /gateway/auth/login',
    'GET /gateway/auth/session',
  ]),
  async run({ ui }) {
    await ui.signIn();
    // Home is a chat with switch-buddy or the workspace at a glance, by flag:
    // either way the rail marks it as the page open.
    await expect
      .poll(() =>
        ui.nav().getByRole('link', { name: 'Home', exact: true }).getAttribute('aria-current')
      )
      .toBe('page');
    await ui.settled();
  },
};

/**
 * Every page in the navigation rail opens without an error: each link the
 * signed-in admin is shown, so a page added to the rail is visited without
 * this list changing. A settings area's link opens the area's first page.
 */
const everyPage: BrowserScenario = {
  header: browserHeader('gateway-every-page', ['GET /gateway/rooms', 'GET /gateway/agents']),
  async run({ ui, log }) {
    await ui.signIn();
    const links = await ui.navLinks();
    expect(links.map((link) => link.path)).toEqual(expect.arrayContaining(['/chats', '/agents']));
    for (const link of links) {
      await ui.openFromRail(link.label);
      log(`${link.label} (${ui.path()}) opened`);
      // A page that fills the window has no rail: once it is drawn (the old
      // page stays until its code has loaded), back to one that has.
      if (FULL_WINDOW.includes(link.path)) {
        await expect.poll(() => ui.nav().isVisible(), { timeout: 15_000 }).toBe(false);
        await ui.open('/');
      }
    }
  },
};

/** A room made over the API opens on its own page, where it is managed. */
const roomFromList: BrowserScenario = {
  header: browserHeader('gateway-room-from-list', ['GET /gateway/rooms/{room_id}']),
  async run({ ui, fixtures }) {
    const agent = await fixtures.agent('member');
    const room = await fixtures.internalRoom('room', [agent]);
    await ui.signIn();
    await ui.open(`/rooms/${room.id}/manage`);
    await expect.poll(() => ui.path()).toBe(`/rooms/${room.id}/manage`);
    await expect
      .poll(() => ui.page.getByRole('heading', { name: room.name }).isVisible())
      .toBe(true);
    await ui.settled();
  },
};

/**
 * A room made in the dashboard's New room dialog exists in the backend as
 * asked: a room on no messaging app (so no platform channel is made on a
 * shared deployment) with the agent picked in the dialog as its member, opened
 * in Chats. Made from the dashboard rather than by adding a bot on the
 * platform, which is the path where the first bot added to a new channel
 * creates no room.
 */
const createRoom: BrowserScenario = {
  header: browserHeader('gateway-create-room', ['POST /gateway/chats']),
  async run({ ui, fixtures, names, switchClient, log }) {
    const agent = await fixtures.agent('member');
    const name = names.name('ui-room');
    const description = `Made in the dashboard's New room dialog by the Switch end-to-end harness (run ${names.runId}). Safe to delete.`;
    await ui.signIn();
    await ui.open('/chats?tab=rooms');
    await ui.page.getByRole('button', { name: 'New Room' }).click();
    const dialog = ui.page.getByRole('dialog');
    await dialog.getByPlaceholder('Name this room').fill(name);
    await dialog.getByPlaceholder('What this room is for').fill(description);
    await dialog.getByRole('combobox', { name: 'Add agents or people' }).fill(agent.name);
    await dialog.getByRole('option').filter({ hasText: agent.name }).click();
    // The room is known from the create call's answer, not from where the page
    // goes next, so it is removed even if the page never gets there.
    const created = ui.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/gateway/chats'),
      { timeout: 15_000 }
    );
    await dialog.getByRole('button', { name: /^Create room/ }).click();
    const response = await created;
    expect(response.status(), 'the create call failed').toBeLessThan(300);
    const roomId = ((await response.json()) as { chat?: { roomId?: unknown } }).chat?.roomId;
    if (typeof roomId !== 'string') {
      throw new Error(`the create call answered without a room id: ${await response.text()}`);
    }
    fixtures.defer(`room ${name} (${roomId})`, () => switchClient.deleteRoom(roomId));
    log(`created room ${name} (${roomId}) from the New room dialog`);
    await expect.poll(() => ui.path(), { timeout: 15_000 }).toBe(`/chats/rooms/${roomId}`);

    const room = await switchClient.getRoom(roomId);
    expect(room.name).toBe(name);
    expect(room.bridgeId, 'the room was asked for with no bridge').toBeNull();
    expect(room.externalChannelId).toBeNull();
    expect(room.agentIds).toEqual([agent.id]);
    // The room's header names it (the list beside it does too).
    await expect
      .poll(() => ui.page.locator('header').getByText(name, { exact: true }).isVisible())
      .toBe(true);
    await ui.settled();
  },
};

/** Signing out ends the session: the app returns to the login form and stays there. */
const signOut: BrowserScenario = {
  header: browserHeader('gateway-sign-out', ['POST /gateway/auth/logout']),
  async run({ ui }) {
    await ui.signIn();
    await ui.signOut();
    await ui.goto('/agents');
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
  ...ROLE_MATRIX_SCENARIOS,
];

import type { BrowserContext, ConsoleMessage, Locator, Page, Request, Response } from 'playwright';
import { expect } from 'vitest';
import type { MatrixLayout } from '../../../../gateway/src/routes/roleMatrix.ts';
import type { SwitchEnv } from '../core/env.ts';
import type { IssuedSecrets } from '../core/secrets.ts';

/** The session cookie the gateway sets on sign-in. */
const SESSION_COOKIE = 'switch_auth';

/** How long a page must go without a `/gateway` request in flight to count as settled. */
const QUIET_MS = 500;
/** How long a page may take to settle before what it is still waiting for is a problem. */
const SETTLE_TIMEOUT_MS = 15_000;

/**
 * Requests that stay open for as long as the page does, and so never finish:
 * waiting for them would never settle.
 */
const STREAMING = new Set(['eventsource', 'websocket']);

/**
 * How each browser reports a request it cancelled itself: the page navigated
 * away mid-request, or a component unmounted and aborted its fetch. Nothing
 * went wrong on the server.
 */
const ABORTED = /net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i;

/** Where signing in lands, in each layout of the dashboard. */
const LANDING: Record<MatrixLayout, string> = { current: '/rooms', v2: '/overview' };

/**
 * What a page of the dashboard shows: the page itself, or one of the app's
 * own status pages in its place (`gateway/src/routes/StatusPages.tsx`).
 */
export type PageState = 'page' | 'refused' | 'not-enabled' | 'planned' | 'not-found';

/** Routes the server mounts only behind a feature flag; the organization page
 * hides the section on a 404, so a server without the flag is not an error. */
const FLAG_GATED_ROUTES = /^\/gateway\/organizations\/current\/(services|connector-apps)(\/|$)/;

/**
 * The gateway UI in one browser context, and everything that went wrong on its
 * pages while a scenario drove it.
 *
 * A page can render and still be broken: a React error caught by nothing, a
 * request the server answered with a 500 that the page shows as an empty
 * table. So every page error, every console error, and every `/gateway`
 * response the server failed is recorded, and the suite fails a scenario that
 * left any, whether or not its own assertions passed.
 *
 * A 4xx is the page's business (a 401 is how the login page learns there is no
 * session) and is recorded only when the scenario says it was signed in, where
 * none is expected.
 */
export class GatewayUi {
  readonly page: Page;
  /** The dashboard's layout on this server: `v2` when `gateway_v2` is on. */
  readonly layout: MatrixLayout;
  private readonly context: BrowserContext;
  private readonly baseUrl: string;
  private readonly credentials: SwitchEnv;
  private readonly secrets: IssuedSecrets;
  private readonly problems: string[] = [];
  /** Each `/gateway` request still in flight, with the page that made it. */
  private readonly inFlight = new Map<Request, string>();
  private lastActivityMs = Date.now();
  private signedIn = false;

  constructor(
    context: BrowserContext,
    page: Page,
    baseUrl: string,
    layout: MatrixLayout,
    credentials: SwitchEnv,
    secrets: IssuedSecrets
  ) {
    this.context = context;
    this.page = page;
    this.layout = layout;
    this.baseUrl = baseUrl;
    this.credentials = credentials;
    this.secrets = secrets;
    page.on('pageerror', (error) => this.problems.push(`page error: ${error.message}`));
    page.on('console', (entry) => this.onConsole(entry));
    page.on('request', (request) => {
      if (!this.isGatewayApi(request.url()) || STREAMING.has(request.resourceType())) return;
      this.inFlight.set(request, this.path());
      this.lastActivityMs = Date.now();
    });
    page.on('response', (response) => this.onResponse(response));
    page.on('requestfinished', (request) => this.settle(request));
    page.on('requestfailed', (request) => {
      const from = this.settle(request);
      if (!this.isGatewayApi(request.url())) return;
      const reason = request.failure()?.errorText ?? 'unknown';
      if (ABORTED.test(reason)) return;
      this.problems.push(
        `${request.method()} ${this.pathOf(request.url())} failed on ${from}: ${reason}`
      );
    });
  }

  /** The request is done: forget it, and return the page that made it. */
  private settle(request: Request): string {
    const from = this.inFlight.get(request) ?? this.path();
    if (this.inFlight.delete(request)) this.lastActivityMs = Date.now();
    return from;
  }

  /** Every problem recorded on the pages so far. */
  recorded(): readonly string[] {
    return this.problems;
  }

  async goto(path: string): Promise<void> {
    await this.page.goto(`${this.baseUrl}${path}`);
  }

  /** The workspace this browser's session is in, as the server has it. */
  async workspaceId(): Promise<string | null> {
    const response = await this.page.request.get(`${this.baseUrl}/gateway/auth/session`);
    if (!response.ok()) {
      throw new Error(`GET /gateway/auth/session answered ${response.status()}`);
    }
    const body = (await response.json()) as { tenant: { id: string } | null };
    return body.tenant?.id ?? null;
  }

  /**
   * Put this browser's session in a workspace the way the app's own switch
   * does, then reopen the start page. For setting a scenario up; a scenario
   * about switching uses the app's switcher instead.
   */
  async enterWorkspace(workspaceId: string): Promise<void> {
    await this.quiet();
    const response = await this.page.request.post(
      `${this.baseUrl}/gateway/tenants/${encodeURIComponent(workspaceId)}/switch`
    );
    if (!response.ok()) {
      throw new Error(`Entering workspace ${workspaceId} answered ${response.status()}`);
    }
    await this.recordSessionCookie();
    await this.open('/');
  }

  /**
   * Open the workspace switcher: the top bar's breadcrumb in the new layout.
   * Today's layout lists the other workspaces in the account menu instead.
   */
  private async openSwitcher(): Promise<Locator> {
    if (this.layout === 'v2') {
      await this.page.locator('button[aria-haspopup="menu"]').click();
      const menu = this.page.getByRole('menu', { name: 'Workspaces' });
      await expect.poll(() => menu.isVisible(), { timeout: 15_000 }).toBe(true);
      return menu;
    }
    await this.page.getByRole('button', { name: 'Account menu' }).click();
    const menu = this.page.getByRole('menu');
    await expect.poll(() => menu.isVisible(), { timeout: 15_000 }).toBe(true);
    return menu;
  }

  private async closeMenu(menu: Locator): Promise<void> {
    await this.page.keyboard.press('Escape');
    await expect.poll(() => menu.isVisible(), { timeout: 15_000 }).toBe(false);
  }

  /**
   * Switch workspace with the app's own switcher, and wait until the server
   * has the session there and the page it lands on has settled.
   */
  async switchWorkspace(workspace: { id: string; name: string }): Promise<void> {
    await this.quiet();
    const menu = await this.openSwitcher();
    const item =
      this.layout === 'v2'
        ? menu.getByRole('menuitem').filter({ hasText: workspace.name })
        : menu.getByRole('menuitem', { name: `Switch to ${workspace.name}`, exact: true });
    if ((await item.count()) !== 1) {
      const offered = (await menu.getByRole('menuitem').allInnerTexts()).map((t) => t.trim());
      throw new Error(
        `The switcher does not offer ${workspace.name} once (it offers: ${offered.join(' | ')}).`
      );
    }
    // The switch reloads the app, and its requests in flight with it.
    const reloaded = this.page.waitForEvent('load', { timeout: 15_000 });
    await item.click();
    await reloaded;
    await expect.poll(() => this.workspaceId(), { timeout: 15_000 }).toBe(workspace.id);
    await expect
      .poll(() => this.page.getByRole('main').isVisible(), { timeout: 15_000 })
      .toBe(true);
    await this.recordSessionCookie();
    await this.settled();
  }

  /** Whether the new layout's switcher offers to invite people to the current workspace. */
  async switcherOffersInvite(): Promise<boolean> {
    const menu = await this.openSwitcher();
    const offers = (await menu.getByRole('menuitem', { name: /^Invite people to / }).count()) > 0;
    await this.closeMenu(menu);
    return offers;
  }

  /** The organizations the new layout's switcher groups workspaces under, by name. */
  async switcherOrganizations(): Promise<string[]> {
    const menu = await this.openSwitcher();
    const headings = (await menu.locator('.MuiListSubheader-root').allInnerTexts()).map((t) =>
      t.trim()
    );
    await this.closeMenu(menu);
    return headings;
  }

  /** The page signing in lands on in this layout. */
  get landing(): string {
    return LANDING[this.layout];
  }

  /** Sign in through the login form as the gateway admin, and land on the start page. */
  async signIn(): Promise<void> {
    await this.signInAs({
      email: this.credentials.gatewayAdminEmail,
      password: this.credentials.gatewayAdminPassword,
    });
  }

  /**
   * Sign in through the login form as someone, and land on the start page of
   * the workspace their sign-in selects.
   */
  async signInAs(account: { email: string; password: string }): Promise<void> {
    await this.goto('/');
    await expect.poll(() => this.path(), { timeout: 15_000 }).toBe('/login');
    await this.page.getByLabel('Email').fill(account.email);
    await this.page.getByLabel('Password').fill(account.password);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => this.path(), { timeout: 15_000 }).toBe(this.landing);
    await this.recordSessionCookie();
    this.signedIn = true;
  }

  async signOut(): Promise<void> {
    await this.page.getByRole('button', { name: 'Account menu' }).click();
    await this.page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    this.signedIn = false;
    await expect.poll(() => this.path(), { timeout: 15_000 }).toBe('/login');
    // The login form fetches its config as it mounts; navigating away before
    // that answers aborts it, which the app reports as a console error.
    await this.settled();
  }

  /** The path the app is showing. */
  path(): string {
    return new URL(this.page.url()).pathname;
  }

  /** The navigation rail. */
  nav(): Locator {
    return this.page.getByRole('navigation', { name: 'Main' });
  }

  /**
   * Open `path` with a fresh page load, as a typed URL or a followed link
   * would, and wait until it has settled.
   */
  async open(path: string): Promise<void> {
    await this.quiet();
    await this.goto(path);
    // The page's own surface; the rail is not on every page.
    await expect
      .poll(() => this.page.getByRole('main').isVisible(), {
        timeout: 15_000,
        message: `the dashboard did not open ${path}`,
      })
      .toBe(true);
    await this.settled();
  }

  /**
   * Forget what the app remembers in this browser, the settings page each
   * area last showed above all, so the next page opens as on a first visit.
   */
  async forgetRemembered(): Promise<void> {
    await this.page.evaluate(() => window.localStorage.clear());
  }

  /** What the app is showing: the page, or a status page in its place. */
  async pageState(): Promise<PageState> {
    const heading = (name: string): Promise<boolean> =>
      this.page.getByRole('heading', { name, exact: true }).isVisible();
    if (await heading("You don't have access to this page")) return 'refused';
    if (await heading('Not turned on')) return 'not-enabled';
    if (await heading("There's no page here")) return 'not-found';
    const planned = this.page
      .getByRole('alert')
      .filter({ hasText: "This page is part of the new layout and isn't built yet." });
    if (await planned.isVisible()) return 'planned';
    return 'page';
  }

  /** The links in a navigation landmark, by label, in order. */
  async linksIn(nav: Locator): Promise<{ label: string; path: string }[]> {
    await expect.poll(() => nav.getByRole('link').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    const links: { label: string; path: string }[] = [];
    for (const link of await nav.getByRole('link').all()) {
      const href = await link.getAttribute('href');
      const label = (await link.innerText()).trim();
      if (href !== null && href.startsWith('/')) links.push({ label, path: href });
    }
    return links;
  }

  /**
   * Follow the rail's link to a page, and wait until the app is there: at the
   * link's own path, or, for a settings area, at the page the area opens.
   */
  async openFromRail(label: string): Promise<void> {
    const link = this.nav().getByRole('link', { name: label, exact: true });
    const href = await link.getAttribute('href');
    if (href === null) throw new Error(`The rail's ${label} link has no address.`);
    await link.click();
    await expect.poll(() => this.path().startsWith(href), { timeout: 15_000 }).toBe(true);
    await this.settled();
  }

  /** The navigation rail's links, by label, as the signed-in user sees them. */
  async navLinks(): Promise<{ label: string; path: string }[]> {
    return this.linksIn(this.nav());
  }

  /**
   * Wait until the page has stopped fetching, then fail on an error it shows.
   *
   * A route change in the app is not a page load, so the browser's own
   * `networkidle` was reached long ago and says nothing about the new page.
   * Settled is instead no `/gateway` request in flight for `QUIET_MS`, which
   * also covers a page whose effects fetch a moment after it renders. MUI
   * renders every error banner as an `alert`; a page with nothing wrong shows
   * none with error severity.
   */
  async settled(): Promise<void> {
    await this.quiet();
    const alerts = this.page.locator('[role="alert"].MuiAlert-colorError');
    const shown = await alerts.allInnerTexts();
    for (const text of shown) this.problems.push(`${this.path()} shows an error: ${text.trim()}`);
  }

  /**
   * Wait until no `/gateway` request has been in flight for `QUIET_MS`.
   * Before leaving a page too: leaving mid-request aborts the request, which
   * the app reports as a console error.
   */
  private async quiet(): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (this.inFlight.size > 0 || Date.now() - this.lastActivityMs < QUIET_MS) {
      if (Date.now() > deadline) {
        const waiting = [...this.inFlight.keys()].map(
          (request) => `${request.method()} ${this.pathOf(request.url())}`
        );
        this.problems.push(
          `${this.path()} had not settled after ${SETTLE_TIMEOUT_MS / 1000} s, still waiting on: ${waiting.join(', ')}`
        );
        break;
      }
      await this.page.waitForTimeout(50);
    }
  }

  async screenshot(file: string): Promise<void> {
    await this.page.screenshot({ path: file, fullPage: true });
  }

  /**
   * The session cookie is a credential the server issued the harness, valid
   * until it expires on a shared deployment, so it goes to the run's issued
   * secrets for the artefact scan.
   */
  private async recordSessionCookie(): Promise<void> {
    const cookies = await this.context.cookies();
    const session = cookies.find((cookie) => cookie.name === SESSION_COOKIE);
    if (session === undefined) {
      throw new Error(
        `Signed in, but the gateway set no ${SESSION_COOKIE} cookie (cookies: ${cookies.map((c) => c.name).join(', ') || 'none'}).`
      );
    }
    this.secrets.record(session.value);
  }

  private onConsole(entry: ConsoleMessage): void {
    if (entry.type() !== 'error') return;
    // The browser's own line for a failed response; `onResponse` judges those.
    if (entry.text().startsWith('Failed to load resource')) return;
    this.problems.push(`console error on ${this.path()}: ${entry.text().slice(0, 300)}`);
  }

  private onResponse(response: Response): void {
    if (!this.isGatewayApi(response.url())) return;
    const status = response.status();
    const failed = status >= 500 || (this.signedIn && status >= 400);
    if (!failed) return;
    if (status === 404 && FLAG_GATED_ROUTES.test(new URL(response.url()).pathname)) return;
    const from = this.inFlight.get(response.request()) ?? this.path();
    this.problems.push(
      `${response.request().method()} ${this.pathOf(response.url())} answered ${status} on ${from}`
    );
  }

  private isGatewayApi(url: string): boolean {
    const parsed = new URL(url);
    return (
      parsed.origin === new URL(this.baseUrl).origin && parsed.pathname.startsWith('/gateway/')
    );
  }

  private pathOf(url: string): string {
    return new URL(url).pathname;
  }
}

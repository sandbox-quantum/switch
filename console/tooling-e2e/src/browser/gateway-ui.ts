import type { BrowserContext, ConsoleMessage, Locator, Page, Request, Response } from 'playwright';
import { expect } from 'vitest';
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
    credentials: SwitchEnv,
    secrets: IssuedSecrets
  ) {
    this.context = context;
    this.page = page;
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

  /** Sign in through the login form as the gateway admin, and land on the rooms page. */
  async signIn(): Promise<void> {
    await this.goto('/');
    await expect.poll(() => this.path(), { timeout: 15_000 }).toBe('/login');
    await this.page.getByLabel('Email').fill(this.credentials.gatewayAdminEmail);
    await this.page.getByLabel('Password').fill(this.credentials.gatewayAdminPassword);
    await this.page.getByRole('button', { name: 'Sign in' }).click();
    await expect.poll(() => this.path(), { timeout: 15_000 }).toBe('/rooms');
    await this.recordSessionCookie();
    this.signedIn = true;
  }

  async signOut(): Promise<void> {
    await this.page.getByRole('button', { name: 'Account menu' }).click();
    await this.page.getByRole('menuitem', { name: 'Sign out' }).click();
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

  /** The navigation rail's links, by label, as the signed-in user sees them. */
  async navLinks(): Promise<{ label: string; path: string }[]> {
    const nav = this.nav();
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
    const alerts = this.page.locator('[role="alert"].MuiAlert-colorError');
    const shown = await alerts.allInnerTexts();
    for (const text of shown) this.problems.push(`${this.path()} shows an error: ${text.trim()}`);
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

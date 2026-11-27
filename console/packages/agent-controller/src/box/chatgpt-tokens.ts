import { createHash } from 'node:crypto';
import type { Logger } from '../log';
import type { GivenLogin } from '../sealed-logins';
import { proxiedTokenPost } from './proxy-transport';
import type { TokenPost } from './vertex-tokens';

/**
 * A Codex ChatGPT sign-in (`codex login`'s `auth.json`) held for the provider
 * gateway (`provider-gateway.ts`). The gateway adds its access token and
 * account id to each call to the ChatGPT backend; the agents' Codex gets only
 * the gateway's base URL and its own opaque token, never these.
 *
 * The access token is renewed shortly before it expires, and once more when
 * the backend refuses it. OpenAI's refresh tokens rotate and a used one is
 * refused ever after, so one refresh runs at a time for every agent on the
 * box, and each rotation is sealed again and kept with Switch (`save`) in
 * place of the login it came from, the way the login was given. A refresh,
 * the refresh token, the access token and the endpoint's answer are never
 * logged.
 *
 * The refresh is Codex's own (openai/codex `codex-rs/login`): a
 * `refresh_token` grant to OpenAI's token endpoint with Codex's client id.
 */

/** OpenAI's token endpoint: the only place a refresh token is ever sent. */
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
/** The issuer Codex records for the sign-in, when it records one. */
const CHATGPT_ISSUER = 'https://auth.openai.com';
/** Codex's own OAuth client id, which its sign-ins are issued to. */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** An access token is renewed this long before it expires (as Codex does). */
export const RENEW_BEFORE_MS = 5 * 60 * 1000;
/** A rotation Switch didn't take is offered again at most this often. */
const SAVE_RETRY_MS = 60_000;

/** OpenAI refused the refresh (`status` is its HTTP status): the sign-in must be made again. */
export class ChatgptRefreshRefused extends Error {
  constructor(readonly status: number) {
    super(`OpenAI refused to renew the ChatGPT sign-in (HTTP ${status}). Sign in again.`);
    this.name = 'ChatgptRefreshRefused';
  }
}

/** The refresh got no usable answer from OpenAI (unreachable, or a passing error there); tried again on the next call. */
export class ChatgptRefreshUnreachable extends Error {
  constructor() {
    super('Could not renew the ChatGPT sign-in with OpenAI just now.');
    this.name = 'ChatgptRefreshUnreachable';
  }
}

/** OpenAI's answers that say the refresh token itself is no good, as Codex reads them. */
const PERMANENT = new Set([400, 401, 403]);

/** Switch holds a newer login for the provider than the one a rotation replaces. */
export class LoginReplaced extends Error {
  constructor() {
    super('Switch holds a newer login for this provider.');
    this.name = 'LoginReplaced';
  }
}

/**
 * Keeps a rotated login with Switch in place of revision `replaces`, sealed to
 * this machine's key; resolves with the revision Switch gave it. Throws
 * `LoginReplaced` when Switch holds another revision now.
 */
export type SaveLogin = (provider: string, replaces: string, credential: string) => Promise<string>;

type Tokens = {
  access: string;
  refresh: string;
  accountId: string;
  clientId: string;
};

function claims(jwt: string): Record<string, unknown> | null {
  const payload = jwt.split('.')[1];
  if (!payload) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The ChatGPT account an id token names (`https://api.openai.com/auth`.`chatgpt_account_id`). */
function accountOf(idToken: unknown): string | null {
  const id = text(idToken);
  const auth = id ? claims(id)?.['https://api.openai.com/auth'] : null;
  return auth && typeof auth === 'object'
    ? text((auth as Record<string, unknown>).chatgpt_account_id)
    : null;
}

function tokensOf(auth: Record<string, unknown>): Tokens | null {
  const tokens = auth.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  const t = tokens as Record<string, unknown>;
  const access = text(t.access_token);
  const refresh = text(t.refresh_token);
  const accountId = text(t.account_id) ?? accountOf(t.id_token);
  if (!access || !refresh || !accountId) return null;
  // Codex records who issued the sign-in; only OpenAI's own is renewed, and only there.
  const provenance = t.oauth_provenance as Record<string, unknown> | undefined;
  if (provenance && typeof provenance === 'object') {
    const issuer = text(provenance.issuer)?.replace(/\/+$/, '');
    if (issuer !== CHATGPT_ISSUER) return null;
  }
  const clientId =
    provenance && typeof provenance === 'object'
      ? (text(provenance.client_id) ?? CODEX_CLIENT_ID)
      : CODEX_CLIENT_ID;
  return { access, refresh, accountId, clientId };
}

/**
 * The sign-in file as JSON, when it is a ChatGPT sign-in this gateway can
 * renew and front: tokens with an access token, a refresh token and the
 * ChatGPT account, issued by OpenAI. Null for anything else (an API key kept
 * in the file, another issuer, not JSON).
 */
export function parseChatgptSignIn(credential: string): Record<string, unknown> | null {
  let auth: unknown;
  try {
    auth = JSON.parse(credential);
  } catch {
    return null;
  }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  return tokensOf(auth as Record<string, unknown>) ? (auth as Record<string, unknown>) : null;
}

function digest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type ChatgptTokensDeps = {
  /** Posts the form to OpenAI; through the box's proxy by default, replaced in tests. */
  post?: TokenPost;
  /** Keeps a rotation with Switch; null where this controller keeps no sealing key. */
  save: SaveLogin | null;
  log: Logger;
  now?: () => number;
};

export class ChatgptTokens {
  private auth: Record<string, unknown>;
  private tokens: Tokens;
  /** The revision Switch holds this login at: what the next save replaces. */
  private revision: string;
  /** Every refresh token this login has held: a login carrying one is this one, perhaps older. */
  private readonly lineage = new Set<string>();
  private pending: Promise<void> | null = null;
  /** OpenAI refused the refresh token: it is never sent again, and calls fail at once. */
  private refused: ChatgptRefreshRefused | null = null;
  /** Saves run one after another, each keeping the newest tokens. */
  private saving: Promise<void> = Promise.resolve();
  private unsaved = false;
  private lastSave = 0;
  /** Switch holds a newer login: rotations are no longer kept there. */
  private replaced = false;
  /** Bumped by `clear()`: a refresh started before it is never kept. */
  private generation = 0;
  private readonly post: TokenPost;
  private readonly now: () => number;

  constructor(
    private readonly login: GivenLogin,
    private readonly deps: ChatgptTokensDeps
  ) {
    const auth = parseChatgptSignIn(login.credential);
    if (!auth) throw new Error('This Codex sign-in file holds no ChatGPT sign-in.');
    this.auth = auth;
    this.tokens = tokensOf(auth)!;
    this.revision = login.revision;
    this.lineage.add(digest(this.tokens.refresh));
    this.post = deps.post ?? proxiedTokenPost();
    this.now = deps.now ?? Date.now;
  }

  /** The headers the gateway adds upstream: the access token and the ChatGPT account. */
  async credential(): Promise<{ header: string; value: string; extra: Record<string, string> }> {
    if (this.expiring()) await this.refresh();
    if (this.unsaved && this.now() - this.lastSave >= SAVE_RETRY_MS) this.keep();
    return {
      header: 'authorization',
      value: `Bearer ${this.tokens.access}`,
      extra: { 'chatgpt-account-id': this.tokens.accountId },
    };
  }

  /**
   * The backend refused `value` (the authorization header a call carried):
   * renew it, unless another call already has.
   */
  async rejected(value: string): Promise<void> {
    if (value === `Bearer ${this.tokens.access}`) await this.refresh();
  }

  /**
   * Whether `login` is this sign-in, at this rotation or an earlier one: a
   * login Switch gives again after a save, or one fetched before it landed.
   * A newer revision of it is what later saves replace.
   */
  adopt(login: GivenLogin): boolean {
    if (login.owner !== this.login.owner) return false;
    const auth = parseChatgptSignIn(login.credential);
    const tokens = auth ? tokensOf(auth) : null;
    if (!tokens || !this.lineage.has(digest(tokens.refresh))) return false;
    if (Number(login.revision) > Number(this.revision)) {
      this.revision = login.revision;
      this.replaced = false;
      // Switch's copy may be older than these tokens: offer ours again.
      if (tokens.refresh !== this.tokens.refresh) this.keep();
    }
    return true;
  }

  /** The login was withdrawn or replaced: nothing it starts from now on is kept. */
  clear(): void {
    this.pending = null;
    this.generation += 1;
  }

  private expiring(): boolean {
    const exp = claims(this.tokens.access)?.exp;
    // No expiry to read: used until the backend refuses it.
    if (typeof exp !== 'number') return false;
    return this.now() >= exp * 1000 - RENEW_BEFORE_MS;
  }

  /** One refresh for every caller that needs one while it runs. */
  private refresh(): Promise<void> {
    if (!this.pending) {
      const run: Promise<void> = this.exchange().finally(() => {
        if (this.pending === run) this.pending = null;
      });
      this.pending = run;
    }
    return this.pending;
  }

  private async exchange(): Promise<void> {
    if (this.refused) throw this.refused;
    const generation = this.generation;
    let answer: Awaited<ReturnType<TokenPost>>;
    try {
      answer = await this.post(CHATGPT_TOKEN_URL, {
        grant_type: 'refresh_token',
        client_id: this.tokens.clientId,
        refresh_token: this.tokens.refresh,
      });
    } catch {
      throw new ChatgptRefreshUnreachable();
    }
    const body = (answer.body ?? {}) as Record<string, unknown>;
    const access = text(body.access_token);
    if (answer.status !== 200 || !access) {
      // Never the body: it can echo what was sent.
      this.deps.log.warn('OpenAI did not renew a Codex ChatGPT sign-in', {
        provider: this.login.provider,
        status: answer.status,
      });
      if (!PERMANENT.has(answer.status)) throw new ChatgptRefreshUnreachable();
      if (generation === this.generation) this.refused = new ChatgptRefreshRefused(answer.status);
      throw new ChatgptRefreshRefused(answer.status);
    }
    if (generation !== this.generation) return;
    const previous = (this.auth.tokens ?? {}) as Record<string, unknown>;
    const idToken = text(body.id_token) ?? previous.id_token;
    const refresh = text(body.refresh_token) ?? this.tokens.refresh;
    const accountId = text(previous.account_id) ?? accountOf(idToken) ?? this.tokens.accountId;
    this.auth = {
      ...this.auth,
      tokens: {
        ...previous,
        id_token: idToken,
        access_token: access,
        refresh_token: refresh,
        account_id: accountId,
      },
      last_refresh: new Date(this.now()).toISOString(),
    };
    this.tokens = { ...this.tokens, access, refresh, accountId };
    this.lineage.add(digest(refresh));
    this.deps.log.info('Renewed a Codex ChatGPT sign-in', { provider: this.login.provider });
    this.keep();
  }

  /** Keeps the newest tokens with Switch, after any save already running. */
  private keep(): void {
    this.unsaved = true;
    this.saving = this.saving.then(() => this.save());
  }

  private async save(): Promise<void> {
    if (!this.unsaved || this.replaced) return;
    const save = this.deps.save;
    if (!save) {
      this.unsaved = false;
      this.deps.log.warn(
        'A renewed Codex ChatGPT sign-in is kept in memory only: this controller keeps no sealing key, so it is lost when the controller restarts',
        { provider: this.login.provider }
      );
      return;
    }
    this.lastSave = this.now();
    const credential = JSON.stringify(this.auth);
    try {
      this.revision = await save(this.login.provider, this.revision, credential);
      // A refresh that landed meanwhile queued a save of its own.
      this.unsaved = credential !== JSON.stringify(this.auth);
    } catch (error) {
      if (error instanceof LoginReplaced) {
        this.replaced = true;
        this.unsaved = false;
        this.deps.log.info(
          'A Codex ChatGPT sign-in was replaced in Switch; its renewals are not kept',
          {
            provider: this.login.provider,
          }
        );
        return;
      }
      this.deps.log.warn(
        'Could not keep a renewed Codex ChatGPT sign-in with Switch; offering it again shortly',
        { provider: this.login.provider, error: error instanceof Error ? error.name : 'unknown' }
      );
    }
  }

  /** Only for tests: when every save started so far has ended. */
  settled(): Promise<void> {
    return this.saving;
  }
}

/**
 * One `ChatgptTokens` per person's sign-in for a provider (keyed by the user
 * who gave the login and the provider), shared by that person's agents on the
 * box, so their refreshes are one; another person's agents never reach it.
 * A login Switch gives again after a save (or a copy fetched before the save
 * landed) keeps the tokens held; a new sign-in replaces them.
 */
export class ChatgptTokenCache {
  private readonly byOwner = new Map<string, ChatgptTokens>();

  constructor(private readonly make: (login: GivenLogin) => ChatgptTokens) {}

  for(login: GivenLogin): ChatgptTokens {
    const key = cacheKey(login.owner, login.provider);
    const held = this.byOwner.get(key);
    if (held?.adopt(login)) return held;
    held?.clear();
    const tokens = this.make(login);
    this.byOwner.set(key, tokens);
    return tokens;
  }

  /** `owner`'s login was withdrawn: its tokens go. */
  forget(owner: string | undefined, provider: string): void {
    const key = cacheKey(owner, provider);
    this.byOwner.get(key)?.clear();
    this.byOwner.delete(key);
  }
}

/** A login from a server that names no owner keys as nobody's (`''`): a box's logins are then all its one owner's. */
function cacheKey(owner: string | undefined, provider: string): string {
  return JSON.stringify([owner ?? '', provider]);
}

/**
 * Mattermost REST client for the harness — the *human* half of the loop.
 *
 * Everything here runs as an ordinary user's personal access token, because that
 * is what the scenarios are simulating: a person typing in a channel. The one
 * privileged action is adding an agent's bot account to a channel, which the
 * token can do for a channel it owns.
 *
 * The bot for a Switch agent is created by the Mattermost collaboration adapter
 * at agent-registration time, with `username === agentName` verbatim
 * (`create_agent_identity` -> `POST /api/v4/bots {username: agent_name}`). That
 * naming rule is why {@link MattermostClient.findBotUser} is a plain username
 * lookup, and why agent names must satisfy Mattermost's username rules:
 * lowercase, `[a-z0-9._-]`, 3-22 characters.
 */

export interface MattermostTeam {
  id: string;
  name: string;
  display_name: string;
}

export interface MattermostChannel {
  id: string;
  name: string;
  display_name: string;
  team_id: string;
}

export interface MattermostUser {
  id: string;
  username: string;
  is_bot?: boolean;
}

export interface MattermostPost {
  id: string;
  channel_id: string;
  user_id: string;
  message: string;
  create_at: number;
  update_at: number;
  root_id: string;
  type: string;
  props?: Record<string, unknown>;
}

export class MattermostHttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 400)}`);
    this.name = 'MattermostHttpError';
    this.status = status;
    this.body = body;
  }
}

/** Mattermost usernames: lowercase, 3-22 chars, `[a-z0-9._-]`, must start alphanumeric. */
export function isValidMattermostUsername(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{2,21}$/.test(name);
}

export class MattermostClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(params: { url: string; token: string }) {
    this.baseUrl = params.url.endsWith('/') ? params.url.slice(0, -1) : params.url;
    this.token = params.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { allow404?: boolean } = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${this.baseUrl}/api/v4${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 404 && options.allow404) return null as T;
    if (!response.ok) {
      throw new MattermostHttpError(method, path, response.status, await response.text());
    }
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }

  /** `GET /api/v4/users/me` — also the reachability + token-validity probe. */
  async me(): Promise<MattermostUser> {
    return this.request<MattermostUser>('GET', '/users/me');
  }

  /** `GET /api/v4/teams/name/{team}` — `team` is the URL slug, e.g. `switch`. */
  async findTeam(teamName: string): Promise<MattermostTeam> {
    const team = await this.request<MattermostTeam | null>(
      'GET',
      `/teams/name/${encodeURIComponent(teamName)}`,
      undefined,
      { allow404: true }
    );
    if (!team) throw new Error(`Mattermost team '${teamName}' not found`);
    return team;
  }

  /**
   * `POST /api/v4/channels` with `team_id` in the **body** — create an open
   * channel. (There is no `POST /teams/{id}/channels`; that path 404s.) The
   * creating user is a member automatically, which is what lets the harness post
   * into it afterwards.
   */
  async createChannel(params: {
    teamId: string;
    name: string;
    displayName: string;
    purpose?: string;
  }): Promise<MattermostChannel> {
    return this.request<MattermostChannel>('POST', '/channels', {
      team_id: params.teamId,
      name: params.name,
      display_name: params.displayName,
      purpose: params.purpose ?? '',
      type: 'O',
    });
  }

  /** `GET /api/v4/teams/{team_id}/channels` — the team's public channels. */
  async listTeamChannels(teamId: string): Promise<MattermostChannel[]> {
    return this.request<MattermostChannel[]>(
      'GET',
      `/teams/${teamId}/channels?per_page=200`
    );
  }

  /** `GET /api/v4/channels/{id}`. */
  async getChannel(channelId: string): Promise<MattermostChannel> {
    return this.request<MattermostChannel>('GET', `/channels/${channelId}`);
  }

  /** `DELETE /api/v4/channels/{id}` — archives the channel (Mattermost soft-delete). */
  async archiveChannel(channelId: string): Promise<void> {
    await this.request('DELETE', `/channels/${channelId}`);
  }

  /**
   * `GET /api/v4/users/username/{username}`. For a Switch agent's bot this is
   * the agent name verbatim. Returns null when no such user exists yet — the
   * bot is created asynchronously at agent registration, so callers poll.
   */
  async findBotUser(username: string): Promise<MattermostUser | null> {
    return this.request<MattermostUser | null>(
      'GET',
      `/users/username/${encodeURIComponent(username)}`,
      undefined,
      { allow404: true }
    );
  }

  /** Poll {@link findBotUser} until the bridge has minted the agent's bot. */
  async waitForBotUser(username: string, deadlineMs: number): Promise<MattermostUser> {
    const until = Date.now() + deadlineMs;
    for (;;) {
      const user = await this.findBotUser(username);
      if (user) return user;
      if (Date.now() >= until) {
        throw new Error(
          `Mattermost bot account '${username}' did not appear within ${deadlineMs}ms. ` +
            `The Mattermost collaboration bridge mints it at agent registration — check the bridge is running.`
        );
      }
      await sleep(2_000);
    }
  }

  /**
   * `POST /api/v4/channels/{channel_id}/members {user_id}` — adding the agent's
   * bot to a channel is what makes Switch provision a room for it. This is the
   * REST equivalent of typing `!invite-agent @agent-name` in the channel.
   */
  async addUserToChannel(channelId: string, userId: string): Promise<void> {
    await this.request('POST', `/channels/${channelId}/members`, {
      user_id: userId,
      channel_id: channelId,
    });
  }

  /** `POST /api/v4/posts` — post as the token's user. */
  async post(params: {
    channelId: string;
    message: string;
    rootId?: string;
  }): Promise<MattermostPost> {
    return this.request<MattermostPost>('POST', '/posts', {
      channel_id: params.channelId,
      message: params.message,
      root_id: params.rootId ?? '',
    });
  }

  /**
   * `GET /api/v4/channels/{id}/posts?since=<ms>` — posts created or updated at
   * or after `sinceMs`, returned oldest-first here (Mattermost hands back an
   * `order` array that is newest-first).
   */
  async postsSince(channelId: string, sinceMs: number): Promise<MattermostPost[]> {
    const body = await this.request<{
      order: string[];
      posts: Record<string, MattermostPost>;
    }>('GET', `/channels/${channelId}/posts?since=${Math.floor(sinceMs)}`);
    return (body.order ?? [])
      .map((id) => body.posts[id])
      .filter((post): post is MattermostPost => post !== undefined)
      .sort((a, b) => a.create_at - b.create_at);
  }

  /**
   * Wait for a post from `userId` matching `predicate`.
   *
   * Returns the whole transcript seen in the window either way, so a failing
   * scenario can report what the agent *did* say instead of only that it timed
   * out. `sinceMs` advances as posts arrive, and system posts (`type` starting
   * `system_`) are dropped — a bot join emits one and it is not a reply.
   */
  async waitForPost(params: {
    channelId: string;
    fromUserId: string;
    predicate: (post: MattermostPost) => boolean;
    sinceMs: number;
    deadlineMs: number;
    pollIntervalMs?: number;
  }): Promise<{ match: MattermostPost | null; transcript: MattermostPost[] }> {
    const until = Date.now() + params.deadlineMs;
    const transcript: MattermostPost[] = [];
    const seen = new Set<string>();
    let since = params.sinceMs;

    for (;;) {
      const posts = await this.postsSince(params.channelId, since);
      for (const post of posts) {
        if (seen.has(post.id)) continue;
        seen.add(post.id);
        if (post.create_at >= since) since = post.create_at;
        if (post.type?.startsWith('system_')) continue;
        transcript.push(post);
        if (post.user_id === params.fromUserId && params.predicate(post)) {
          return { match: post, transcript };
        }
      }
      if (Date.now() >= until) return { match: null, transcript };
      await sleep(params.pollIntervalMs ?? 2_000);
    }
  }

  /**
   * Whether any post from `userId` arrived in the window — used by the interrupt
   * scenario, which asserts the *absence* of further output rather than the
   * presence of a reply.
   */
  async postsFrom(
    channelId: string,
    userId: string,
    sinceMs: number
  ): Promise<MattermostPost[]> {
    const posts = await this.postsSince(channelId, sinceMs);
    return posts.filter((post) => post.user_id === userId && !post.type?.startsWith('system_'));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

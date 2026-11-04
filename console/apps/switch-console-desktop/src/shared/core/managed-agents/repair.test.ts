import { describe, expect, it } from 'vitest';
import {
  accountLabelOf,
  copiedLoginLine,
  type LoginSourceRecord,
  REPAIR_FAILED,
  RESEAL_WINDOW_MS,
  type RepairPressNote,
  repairRefusal,
  resealPlan,
} from './repair';

const NOW = Date.parse('2026-10-29T18:00:00Z');
const press = (over: Partial<RepairPressNote> = {}): RepairPressNote => ({
  revokedControllerId: 'old',
  revokedAt: '2026-10-29T17:50:00Z',
  pressedAt: NOW - 10 * 60 * 1000,
  copiedControllerId: null,
  ...over,
});
const fresh = { id: 'new', createdAt: '2026-10-29T17:55:00Z' };
const here: LoginSourceRecord = { source: 'this-computer' };

function plan(
  over: Partial<Parameters<typeof resealPlan>[0]> = {},
  sources: Record<string, LoginSourceRecord> = { codex: here }
) {
  return resealPlan({
    now: NOW,
    press: press(),
    controller: fresh,
    providers: ['codex'],
    source: (provider) => sources[provider] ?? null,
    ...over,
  });
}

describe('which logins this Console copies by itself after a repair (design v1.2)', () => {
  it('copies to the first new controller after the press, from this computer', () => {
    expect(plan()).toEqual([{ provider: 'codex', action: 'copy' }]);
    expect(plan({ press: press({ copiedControllerId: 'new' }) })).toEqual([
      { provider: 'codex', action: 'copy' },
    ]);
  });

  it('asks, never copies, for a controller that is not new to the press', () => {
    // The revoked controller itself.
    expect(plan({ controller: { id: 'old', createdAt: fresh.createdAt } })[0]!.action).toBe('ask');
    // Created before the revocation, by Core's own times.
    expect(plan({ controller: { id: 'new', createdAt: '2026-10-29T17:40:00Z' } })[0]!.action).toBe(
      'ask'
    );
    // A second new controller within the window (security's condition).
    expect(plan({ press: press({ copiedControllerId: 'first' }) })[0]!.action).toBe('ask');
    // No Core time to compare with, or no creation time from an older server.
    expect(plan({ press: press({ revokedAt: null }) })[0]!.action).toBe('ask');
    expect(plan({ controller: { id: 'new', createdAt: null } })[0]!.action).toBe('ask');
  });

  it('asks when this Console did not press Repair, or pressed it more than 2 hours ago', () => {
    expect(plan({ press: null })[0]!.action).toBe('ask');
    expect(plan({ press: press({ pressedAt: NOW - RESEAL_WINDOW_MS - 1 }) })[0]!.action).toBe(
      'ask'
    );
    expect(plan({ press: press({ pressedAt: NOW - RESEAL_WINDOW_MS }) })[0]!.action).toBe('copy');
  });

  it('asks for a typed key, a missing record, a pasted Vertex key, and Claude’s own sign-in', () => {
    expect(plan({}, { codex: { source: 'typed' } })[0]!.action).toBe('ask');
    expect(plan({}, {})[0]!.action).toBe('ask');
    expect(
      plan(
        { providers: ['claude'] },
        { claude: { source: 'vertex-key', project: 'p', region: 'r' } }
      )[0]!.action
    ).toBe('ask');
    expect(plan({ providers: ['claude'] }, { claude: here })[0]!.action).toBe('ask');
  });

  it('copies Claude through Vertex from this computer’s gcloud sign-in, and ignores unknown names', () => {
    expect(
      plan(
        { providers: ['claude', 'mystery'] },
        {
          claude: { source: 'vertex-this-computer', project: 'p', region: 'r' },
          mystery: here,
        }
      )
    ).toEqual([
      { provider: 'claude', action: 'copy' },
      { provider: 'mystery', action: 'ask' },
    ]);
  });
});

describe('a refused repair', () => {
  it('shows a fixed line for each reason, never the server’s text', () => {
    expect(repairRefusal(409, 'repair_not_needed')).toBe(
      "Your cloud is signing in again, so there's nothing to repair."
    );
    expect(repairRefusal(409, 'controller_revoked')).toBe(
      "This cloud can't be repaired from here. Reload and try again."
    );
    expect(repairRefusal(404, null)).toBe(
      "This cloud can't be repaired from here. Reload and try again."
    );
    expect(repairRefusal(403, 'paused_by_switch')).toBe(
      "Switch has paused your cloud, so it can't be repaired. Contact your admin."
    );
    expect(repairRefusal(403, 'turned_off_by_admin')).toBe(
      "Your admin has turned off hosted agents, so your cloud can't be repaired. Ask them to turn it back on."
    );
  });

  it('shows the fixed "try again" line for a 403 with no or an unknown reason, and anything else', () => {
    for (const [status, code] of [
      [403, null],
      [403, 'something_new'],
      [500, null],
      [undefined, null],
    ] as const)
      expect(repairRefusal(status, code)).toBe(REPAIR_FAILED);
    expect(REPAIR_FAILED).toBe("The repair didn't go through. Try again in a minute.");
  });
});

describe('the account label in the Repair dialog (copy e16e1212, security)', () => {
  const jwt = (claims: object) =>
    `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;
  const codexFile = (claims: object, extra: object = {}) =>
    JSON.stringify({
      tokens: { id_token: jwt(claims), access_token: 'sk-live-secret', account_id: 'acct-1' },
      ...extra,
    });

  it("reads only the e-mail claim of Codex's id_token", () => {
    expect(accountLabelOf('codex', codexFile({ email: 'alex@example.com', sub: 'x' }))).toBe(
      'alex@example.com'
    );
  });

  it('gives nothing for any other provider, or a file with no e-mail', () => {
    expect(accountLabelOf('opencode', codexFile({ email: 'alex@example.com' }))).toBeUndefined();
    expect(accountLabelOf('codex', codexFile({ sub: 'x' }))).toBeUndefined();
    expect(accountLabelOf('codex', JSON.stringify({ OPENAI_API_KEY: 'sk-x' }))).toBeUndefined();
    expect(accountLabelOf('codex', 'not json')).toBeUndefined();
    expect(
      accountLabelOf('codex', JSON.stringify({ tokens: { id_token: 'no-dots' } }))
    ).toBeUndefined();
  });

  it('drops anything that is not a plain, short e-mail address', () => {
    for (const email of [
      'sk-live-secret',
      '/Users/alex/.codex/auth.json',
      '<b>alex</b>@example.com',
      'alex @example.com',
      `${'a'.repeat(60)}@example.com`,
      42,
    ])
      expect(accountLabelOf('codex', codexFile({ email }))).toBeUndefined();
  });

  it('never returns a token, whatever the file holds', () => {
    const label = accountLabelOf('codex', codexFile({ email: 'alex@example.com' }));
    expect(label).toBe('alex@example.com');
    expect(label).not.toMatch(/sk-live|acct-1/);
  });

  it('words one provider line, with or without a label, capped', () => {
    expect(copiedLoginLine('Codex', 'alex@example.com')).toBe(
      'Codex: copied from this computer (alex@example.com)'
    );
    expect(copiedLoginLine('OpenCode', undefined)).toBe('OpenCode: copied from this computer');
    const long = copiedLoginLine('Codex', 'a'.repeat(100));
    expect(long.length).toBeLessThan(100);
    expect(long).toMatch(/…\)$/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDiagnosticSections,
  getDiagnosticLogAttachment,
  redactDiagnosticLog,
  redactSecrets,
  registerDiagnosticSection,
} from './file-logger';

vi.mock('electron', () => ({
  app: {
    exit: vi.fn(),
    getPath: vi.fn(() => '/tmp/switch-console-test'),
    setAppLogsPath: vi.fn(),
  },
}));

/**
 * A Discord-bot-token-shaped fixture, assembled at runtime.
 *
 * Written as a literal it trips GitHub's push protection, which classifies the
 * shape as a Discord Bot Token regardless of the bytes being invented — fair
 * evidence that the rule under test is aimed at the right thing, but not a
 * reason to make the repo unpushable.
 */
const DISCORD_TOKEN_TAIL = 'abcdefghijklmnopqrstuvwxyz1';
const DISCORD_TOKEN_SHAPE = ['MTA5NjE4NzQ5NDI4Nzk0MjA5', 'GhIjKl', DISCORD_TOKEN_TAIL].join('.');

describe('redactDiagnosticLog', () => {
  it('redacts common secrets in free-form text', () => {
    const redacted = redactDiagnosticLog(
      [
        'authorization: Bearer abc123',
        'api_key=super-secret-key',
        'token: ghp_123456',
        'password=hunter2',
        'sk-abcdefghijklmnopqrstuvwxyz123456',
      ].join('\n')
    );

    expect(redacted).toContain('authorization: [REDACTED]');
    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).toContain('token: [REDACTED]');
    expect(redacted).toContain('password=[REDACTED]');
    expect(redacted).toContain('[REDACTED_OPENAI_KEY]');
  });

  it('redacts secrets embedded in JSON-quoted values', () => {
    const redacted = redactDiagnosticLog(
      JSON.stringify({
        password: 'hunter2',
        api_key: 'super-secret-key',
        authorization: 'Bearer xyz',
        access_token: 'abc',
      })
    );

    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('super-secret-key');
    expect(redacted).not.toContain('Bearer xyz');
    expect(redacted).not.toContain('"abc"');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts secrets embedded in escaped JSON-in-JSON strings', () => {
    const inner = JSON.stringify({ password: 'hunter2' });
    const outer = JSON.stringify({ message: inner });

    const redacted = redactDiagnosticLog(outer);

    expect(redacted).not.toContain('hunter2');
  });

  it('redacts vendor-specific tokens', () => {
    const redacted = redactDiagnosticLog(
      [
        'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'glpat-aaaaaaaaaaaaaaaaaaaa',
        'AKIAABCDEFGHIJKLMNOP',
        'sk_live_aaaaaaaaaaaaaaaaaaaa',
        'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa',
        'xoxb-redacted-example-token',
        'eyJabcdefgh.eyJabcdefgh.signaturebits',
        'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ].join('\n')
    );

    expect(redacted).toContain('[REDACTED_GITHUB_TOKEN]');
    expect(redacted).toContain('[REDACTED_GITLAB_TOKEN]');
    expect(redacted).toContain('[REDACTED_AWS_KEY]');
    expect(redacted).toContain('[REDACTED_STRIPE_KEY]');
    expect(redacted).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(redacted).toContain('[REDACTED_SLACK_TOKEN]');
    expect(redacted).toContain('[REDACTED_JWT]');
    expect(redacted).toContain('[REDACTED_NPM_TOKEN]');
  });

  it('redacts credentials under qualified key names, not just bare ones', () => {
    // Real config keys are qualified. A bare word boundary before `token` does
    // not match `bot_token`, so these are exactly the spellings that used to
    // slip through — and exactly the ones a bridge config uses (CHOO-1784).
    const redacted = redactDiagnosticLog(
      [
        `bot_token=${DISCORD_TOKEN_SHAPE}`,
        '{"app_token":"xapp-1-A0123-456-secretvalue"}',
        'admin_password: hunter2',
        '{"encryption_private_key":"MIIEpAIBAAKCAQEA"}',
        'client-secret = shhhhhhhh',
      ].join('\n')
    );

    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('shhhhhhhh');
    expect(redacted).not.toContain('MIIEpAIBAAKCAQEA');
    expect(redacted).not.toContain('secretvalue');
    expect(redacted).not.toContain(DISCORD_TOKEN_TAIL);
  });

  it('redacts a Slack app token and a Discord bot token', () => {
    const redacted = redactDiagnosticLog(
      ['xapp-1-A012BCDEFGH-1234567890123-abcdef', DISCORD_TOKEN_SHAPE].join('\n')
    );

    expect(redacted).toContain('[REDACTED_SLACK_TOKEN]');
    expect(redacted).toContain('[REDACTED_DISCORD_TOKEN]');
  });

  it('redacts the token after a Bot auth scheme, not just Bearer', () => {
    // `Authorization: Bot <token>` is Discord's canonical header. Redacting the
    // scheme word and leaving the token behind is worse than useless.
    const redacted = redactDiagnosticLog('Authorization: Bot abcdefghijklmnop');

    expect(redacted).not.toContain('abcdefghijklmnop');
  });

  it('leaves non-secret keys alone', () => {
    // The qualifier prefix must not turn every underscored key into a secret.
    const redacted = redactDiagnosticLog(
      ['workspace_id=T0123456', 'room_name: design-review', 'agent_id=agent-7'].join('\n')
    );

    expect(redacted).toContain('T0123456');
    expect(redacted).toContain('design-review');
    expect(redacted).toContain('agent-7');
  });

  it('redacts PEM private-key blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAxyz...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    expect(redactDiagnosticLog(pem)).toBe('[REDACTED_PEM_BLOCK]');
  });

  it('redacts credentials in non-HTTPS DSNs', () => {
    const redacted = redactDiagnosticLog(
      [
        'postgres://admin:s3cret@db.internal/app',
        'mongodb://user:pass@cluster.example.com',
        'redis://default:topsecret@cache.local:6379',
      ].join('\n')
    );

    expect(redacted).toContain('postgres://[REDACTED_CREDENTIALS]@');
    expect(redacted).toContain('mongodb://[REDACTED_CREDENTIALS]@');
    expect(redacted).toContain('redis://[REDACTED_CREDENTIALS]@');
    expect(redacted).not.toContain('s3cret');
    expect(redacted).not.toContain('topsecret');
  });

  it('redacts common PII while keeping useful path shape', () => {
    const redacted = redactDiagnosticLog(
      [
        'email person@example.com',
        'mac /Users/alice/locations/switch-console',
        'linux /home/bob/work/repo',
        'win C:\\Users\\carol\\repo',
        'ipv4 192.168.1.25',
        'ipv6 2001:0db8:85a3:0000:0000:8a2e:0370:7334',
        'macaddr aa:bb:cc:dd:ee:ff',
        'remote git@github.com',
        'url https://alice:secret@example.com/repo',
      ].join('\n')
    );

    expect(redacted).toContain('[REDACTED_EMAIL]');
    expect(redacted).toContain('/Users/[REDACTED_USER]/locations/switch-console');
    expect(redacted).toContain('/home/[REDACTED_USER]/work/repo');
    expect(redacted).toContain('C:\\Users\\[REDACTED_USER]\\repo');
    expect(redacted).toContain('ipv4 [REDACTED_IP]');
    expect(redacted).toContain('ipv6 [REDACTED_IP]');
    expect(redacted).toContain('macaddr [REDACTED_MAC]');
    expect(redacted).toContain('git@[REDACTED_HOST]');
    expect(redacted).toContain('https://[REDACTED_CREDENTIALS]@example.com/repo');
  });
});

describe('redactSecrets (write path)', () => {
  it.each([
    ['bearer authorization', 'authorization: Bearer abc123', 'abc123'],
    ['api key', 'api_key=super-secret-key', 'super-secret-key'],
    ['github token', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ghp_a'],
    ['anthropic key', 'sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa', 'sk-ant-a'],
    ['jwt', 'eyJabcdefgh.eyJabcdefgh.signaturebits', 'signaturebits'],
    ['json password', JSON.stringify({ password: 'hunter2' }), 'hunter2'],
  ])('never lets %s reach disk', (_label, input, secret) => {
    const written = redactSecrets(input);

    expect(written).not.toContain(secret);
    expect(written).toContain('REDACTED');
  });

  it('redacts PEM private-key blocks', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEAxyz...',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');

    expect(redactSecrets(pem)).toBe('[REDACTED_PEM_BLOCK]');
  });

  it.each([
    ['ipv4 address', 'ssh to 192.168.1.25 refused', '192.168.1.25'],
    ['linux home path', 'worktree /home/bob/work/repo missing', '/home/bob/work/repo'],
    ['macos home path', 'worktree /Users/alice/repo missing', '/Users/alice/repo'],
    ['email address', 'signed in as person@example.com', 'person@example.com'],
  ])('keeps %s readable in the local file', (_label, input, retained) => {
    // The local log is the copy the user debugs from; scrubbing the address or
    // path here would delete the very detail a failure report is about. It is
    // removed by redactDiagnosticLog when content actually leaves the machine.
    expect(redactSecrets(input)).toContain(retained);
  });

  it('composes with the export pass, which then removes the rest', () => {
    const line = 'ssh to 192.168.1.25 with token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    const onDisk = redactSecrets(line);
    const exported = redactDiagnosticLog(onDisk);

    expect(onDisk).toContain('192.168.1.25');
    expect(onDisk).not.toContain('ghp_a');
    expect(exported).toContain('[REDACTED_IP]');
    expect(exported).not.toContain('ghp_a');
  });
});

describe('diagnostic sections', () => {
  beforeEach(() => {
    clearDiagnosticSections();
  });

  it('includes a contributed section in the attachment', async () => {
    registerDiagnosticSection('sidecar', async () => 'sidecar said hello');

    const { content } = await getDiagnosticLogAttachment();

    expect(content).toContain('===== sidecar =====');
    expect(content).toContain('sidecar said hello');
  });

  it('redacts contributed sections like everything else', async () => {
    registerDiagnosticSection('sidecar', async () => 'connected from 192.168.1.25');

    const { content } = await getDiagnosticLogAttachment();

    // A section must not become a way around the export scrub.
    expect(content).toContain('[REDACTED_IP]');
    expect(content).not.toContain('192.168.1.25');
  });

  it('reports a failing section rather than omitting it', async () => {
    registerDiagnosticSection('sidecar', async () => {
      throw new Error('host unreachable');
    });

    const { content } = await getDiagnosticLogAttachment();

    // Silence would read as "there was nothing to report" — and an unreachable
    // host is frequently the thing being reported.
    expect(content).toContain('failed to collect');
    expect(content).toContain('host unreachable');
  });

  it('does not let one section block the others', async () => {
    registerDiagnosticSection('slow', () => new Promise<string>(() => {}));
    registerDiagnosticSection('fast', async () => 'collected fine');

    const { content } = await vi.waitFor(() => getDiagnosticLogAttachment(), { timeout: 10_000 });

    expect(content).toContain('collected fine');
    expect(content).toContain('timed out collecting');
  }, 15_000);

  it('omits an empty section entirely', async () => {
    registerDiagnosticSection('empty', async () => '   ');

    const { content } = await getDiagnosticLogAttachment();

    expect(content).not.toContain('===== empty =====');
  });
});

import { describe, expect, it } from 'vitest';
import { gooseAcp, parseGooseStatus } from './goose-acp';

describe('gooseAcp hooks', () => {
  it('launches with acp subcommand', () => {
    const launch = gooseAcp.launch({
      binaryPath: 'goose',
      env: {},
    });
    expect(launch.command).toBe('goose');
    expect(launch.args).toEqual(['acp']);
  });

  it('adds --auto-approve true when autoApprove is enabled', () => {
    const launch = gooseAcp.launch({
      binaryPath: 'goose',
      env: {},
      autoApprove: true,
    });
    expect(launch.args).toEqual(['acp', '--auto-approve', 'true']);
  });

  it('detects GOOSE_API_KEY from environment', async () => {
    const check = await gooseAcp.checkSignIn({
      binaryPath: 'goose',
      cwd: '/test',
      env: { GOOSE_API_KEY: 'test-key' },
    });
    expect(check.status).toBe('authenticated');
  });

  it('parses unauthenticated status correctly', () => {
    const result = parseGooseStatus('No provider configured. Run goose configure to get started.');
    expect(result.status).toBe('unauthenticated');
    expect(result.detail).toContain('goose configure');
  });

  it('parses configured status correctly', () => {
    const result = parseGooseStatus('Goose version 1.0.0 (active)');
    expect(result.status).toBe('authenticated');
  });
});

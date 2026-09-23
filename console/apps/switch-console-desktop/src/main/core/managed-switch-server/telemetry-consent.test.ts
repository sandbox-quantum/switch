import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerHost } from './host/types';

/**
 * Reading back what a managed stack is actually doing about usage data
 * (CHOO-2890).
 *
 * The point of reading it at all is that the Console's own record of what it
 * last wrote can be wrong — a start that wrote the `.env` and then failed
 * leaves the two disagreeing. So the container wins over the file, and a host
 * that answers neither says so instead of falling back on either.
 */

const runningServiceEnvMock = vi.hoisted(() => vi.fn());

vi.mock('./compose', () => ({ runningServiceEnv: runningServiceEnvMock }));
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));

const { readDeployedTelemetry } = await import('./telemetry-consent');

function host(readFile: () => Promise<string | null>): ServerHost {
  return { label: 'this computer', readFile } as unknown as ServerHost;
}

const noEnvFile = () => Promise.resolve(null);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readDeployedTelemetry', () => {
  it('reads the running container, which is what is actually sending', async () => {
    runningServiceEnvMock.mockResolvedValue(new Map([['TELEMETRY_ENABLED', 'true']]));

    expect(await readDeployedTelemetry(host(noEnvFile))).toEqual({ known: true, enabled: true });
  });

  it('prefers the container over a .env that disagrees with it', async () => {
    // Exactly the state a start that wrote the file and then failed leaves
    // behind. Trusting the file here would report a choice as applied that the
    // running server has never seen.
    runningServiceEnvMock.mockResolvedValue(new Map([['TELEMETRY_ENABLED', 'true']]));

    const result = await readDeployedTelemetry(
      host(() => Promise.resolve('TELEMETRY_ENABLED=false\n'))
    );

    expect(result).toEqual({ known: true, enabled: true });
  });

  it('treats a container without the variable as not sharing', async () => {
    // switch-core's own default is off, so a stack started before this existed
    // is genuinely not reporting — this is a reading, not a fallback.
    runningServiceEnvMock.mockResolvedValue(new Map([['SWITCH_VERSION', '0.11.0']]));

    expect(await readDeployedTelemetry(host(noEnvFile))).toEqual({ known: true, enabled: false });
  });

  it.each(['1', 'TRUE', ' yes ', 'on'])('reads %s as sharing', async (value) => {
    runningServiceEnvMock.mockResolvedValue(new Map([['TELEMETRY_ENABLED', value]]));

    expect(await readDeployedTelemetry(host(noEnvFile))).toEqual({ known: true, enabled: true });
  });

  it('falls back to the .env when no container is up', async () => {
    runningServiceEnvMock.mockResolvedValue(null);

    const result = await readDeployedTelemetry(
      host(() => Promise.resolve('SWITCH_VERSION=0.11.0\nTELEMETRY_ENABLED=true\n'))
    );

    expect(result).toEqual({ known: true, enabled: true });
  });

  it('reports a host it could not read, naming both failures', async () => {
    runningServiceEnvMock.mockRejectedValue(new Error('docker daemon down'));

    const result = await readDeployedTelemetry(
      host(() => Promise.reject(new Error('ssh timed out')))
    );

    expect(result.known).toBe(false);
    expect(result).toMatchObject({
      reason: expect.stringContaining('docker daemon down') as unknown as string,
    });
    expect(result).toMatchObject({
      reason: expect.stringContaining('ssh timed out') as unknown as string,
    });
  });

  it('does not let an unreadable host read as agreement', async () => {
    runningServiceEnvMock.mockRejectedValue(new Error('docker daemon down'));

    expect(await readDeployedTelemetry(host(noEnvFile))).toEqual({
      known: false,
      reason: expect.stringContaining('docker daemon down') as unknown as string,
    });
  });
});

import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyDockerError, resolveDockerBin } from './docker';

describe('classifyDockerError', () => {
  it('maps a missing binary (ENOENT) to not-installed', () => {
    const err = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    expect(classifyDockerError(err).reason).toBe('not-installed');
  });

  it('maps a daemon-down message to daemon-down', () => {
    const err = new Error(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
    );
    expect(classifyDockerError(err).reason).toBe('daemon-down');
  });

  it('maps the Windows named-pipe connect failure to daemon-down', () => {
    const err = new Error(
      'error during connect: Get "http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.51/version": ' +
        'open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'
    );
    const result = classifyDockerError(err);
    expect(result.reason).toBe('daemon-down');
    expect(result.detail).toContain('Start Docker Desktop');
  });

  it('maps the legacy docker_engine pipe failure to daemon-down', () => {
    const err = new Error(
      'open //./pipe/docker_engine: The system cannot find the file specified.'
    );
    expect(classifyDockerError(err).reason).toBe('daemon-down');
  });

  it('maps EINVAL from a .cmd shim to not-installed rather than a dead daemon', () => {
    const err = Object.assign(new Error('spawn docker EINVAL'), { code: 'EINVAL' });
    expect(classifyDockerError(err).reason).toBe('not-installed');
  });

  it('falls back to daemon-down with the raw message for unknown failures', () => {
    const err = new Error('some other failure');
    const result = classifyDockerError(err);
    expect(result.reason).toBe('daemon-down');
    expect(result.detail).toContain('some other failure');
  });
});

describe('resolveDockerBin', () => {
  it('honours DOCKER_PATH when it points at a real file', () => {
    const thisFile = fileURLToPath(import.meta.url);
    expect(resolveDockerBin({ DOCKER_PATH: thisFile })).toBe(thisFile);
  });

  it('ignores a DOCKER_PATH that does not exist', () => {
    expect(resolveDockerBin({ DOCKER_PATH: '/definitely/not/a/docker' })).not.toBe(
      '/definitely/not/a/docker'
    );
  });
});

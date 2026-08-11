import { describe, expect, it } from 'vitest';
import { classifyDockerError } from './docker';

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

  it('falls back to daemon-down with the raw message for unknown failures', () => {
    const err = new Error('some other failure');
    const result = classifyDockerError(err);
    expect(result.reason).toBe('daemon-down');
    expect(result.detail).toContain('some other failure');
  });
});

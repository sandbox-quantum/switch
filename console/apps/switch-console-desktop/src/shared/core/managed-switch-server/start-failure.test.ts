import { describe, expect, it } from 'vitest';
import { explainStartFailure } from './start-failure';

describe('explainStartFailure', () => {
  it('finds the port another program holds, from either way Docker says it', () => {
    expect(
      explainStartFailure('compose up failed\ngateway: bind 0.0.0.0:8000: address already in use')
    ).toEqual({
      line: 'gateway: bind 0.0.0.0:8000: address already in use',
      hint: 'Another program is using port 8000. Quit it, or use another port, then try again.',
      port: 8000,
    });
    expect(
      explainStartFailure('Bind for 127.0.0.1:41000 failed: port is already allocated').port
    ).toBe(41000);
  });

  it('says what to do about Docker not running', () => {
    const failure = explainStartFailure(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?'
    );
    expect(failure.hint).toBe("Docker isn't running. Open Docker Desktop, then try again.");
    expect(failure.port).toBeNull();
  });

  it('gives no advice it cannot back, only the first line of an error it does not know', () => {
    expect(explainStartFailure('\nsomething odd happened\nmore detail')).toEqual({
      line: 'something odd happened',
      hint: null,
      port: null,
    });
  });
});

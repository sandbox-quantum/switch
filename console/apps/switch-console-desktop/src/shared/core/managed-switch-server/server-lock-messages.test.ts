import { describe, expect, it } from 'vitest';
import {
  lockHolderSentence,
  ServerBusyError,
  type ServerLockHolder,
  serverBusyMessage,
  stoppedWaitingForLockMessage,
  waitingForLockMessage,
} from './managed-switch-server';

const bob: ServerLockHolder = {
  name: 'bob@desk',
  hostAccount: 'bob',
  action: 'starting',
  heldForSeconds: 40,
  expiresInSeconds: 80,
};

describe('messages about the server lock', () => {
  it('names who a wait is for and what they are doing', () => {
    expect(waitingForLockMessage(bob)).toBe(
      'Waiting for bob@desk (as bob) to finish starting the server…'
    );
    expect(waitingForLockMessage({ ...bob, action: 'connecting' })).toBe(
      'Waiting for bob@desk (as bob) to finish connecting to the server…'
    );
  });

  it('tells the setup step that Start or Connect will wait', () => {
    expect(lockHolderSentence({ ...bob, action: 'updating' })).toBe(
      'bob@desk (as bob) is updating this server right now. Starting or connecting here waits ' +
        'until they are done.'
    );
  });

  it('refuses a stop or reset naming who is busy, and when a gone Console stops counting', () => {
    expect(serverBusyMessage('vm-1', bob)).toBe(
      'bob@desk (as bob) is starting the server on vm-1 right now, so nothing was changed. Try ' +
        'again once they are done. If that Console has gone away, its hold on the server clears ' +
        'by itself within 2 minutes.'
    );
    expect(serverBusyMessage('vm-1', { ...bob, expiresInSeconds: 20 })).toMatch(
      /within a minute\.$/
    );
    expect(serverBusyMessage('vm-1', { ...bob, expiresInSeconds: 0 })).toMatch(
      /within a minute\.$/
    );
  });

  it('carries the refusal and its holder as an error the RPC boundary recognises', () => {
    const error = new ServerBusyError(bob, 'vm-1');

    expect(error.name).toBe('ServerBusyError');
    expect(error.holder).toBe(bob);
    expect(error.message).toBe(serverBusyMessage('vm-1', bob));
  });

  it('says a check that stopped waiting has not happened, with or without a holder', () => {
    expect(stoppedWaitingForLockMessage({ ...bob, action: 'resetting' })).toBe(
      'Stopped waiting for bob@desk (as bob) to finish resetting the server, so this Console has ' +
        'not checked it since.'
    );
    expect(stoppedWaitingForLockMessage(null)).toBe(
      'Stopped waiting for the server, so this Console has not checked it since.'
    );
  });
});

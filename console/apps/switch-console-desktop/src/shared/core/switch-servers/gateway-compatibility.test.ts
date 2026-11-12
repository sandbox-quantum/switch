import { CONTRACTS } from '@switch-console/shared';
import { describe, expect, it } from 'vitest';
import {
  type ConsoleGatewaySide,
  THIS_CONSOLE,
  gatewayCompatibility,
} from './gateway-compatibility';

const app: ConsoleGatewaySide = { version: '0.41.0', range: { speaks: 3, accepts: 2 } };

function declared(speaks: number, accepts: number, version: string | null = '0.32.0') {
  return { version, contracts: { 'gateway-api': { speaks, accepts } } };
}

describe('gatewayCompatibility', () => {
  it('operates at the lower speaks when the ranges overlap', () => {
    expect(gatewayCompatibility('Cloud', declared(4, 1), app)).toEqual({
      kind: 'compatible',
      revision: 3,
    });
    expect(gatewayCompatibility('Cloud', declared(2, 2), app)).toEqual({
      kind: 'compatible',
      revision: 2,
    });
  });

  it('names both versions when the server is too old', () => {
    const result = gatewayCompatibility('Cloud', declared(1, 1, '0.31.0-rc.7'), app);
    expect(result.kind).toBe('server-too-old');
    if (result.kind !== 'server-too-old') return;
    expect(result.message).toContain('switch-core 0.31.0-rc.7');
    expect(result.message).toContain('Switch Console 0.41.0');
    expect(result.message).toContain('Update the server.');
  });

  it('names both versions when this Console is too old', () => {
    const result = gatewayCompatibility('Cloud', declared(5, 4), app);
    expect(result.kind).toBe('console-too-old');
    if (result.kind !== 'console-too-old') return;
    expect(result.message).toContain('switch-core 0.32.0');
    expect(result.message).toContain('Switch Console 0.41.0');
    expect(result.message).toContain('Update Switch Console.');
  });

  it('says the server version is unknown rather than inventing one', () => {
    const result = gatewayCompatibility('Cloud', declared(1, 1, null), app);
    expect(result.kind === 'server-too-old' && result.message).toContain(
      'switch-core of an unknown version'
    );
  });

  it.each([
    ['no declaration', null],
    ['no contracts at all', { version: '0.30.0' }],
    ['contracts that are not an object', { version: '0.30.0', contracts: 'gateway-api' }],
    ['no gateway-api range', { version: '0.30.0', contracts: {} }],
    [
      'a range that is not numbers',
      { version: '0.30.0', contracts: { 'gateway-api': { speaks: '2', accepts: 1 } } },
    ],
    ['accepts above speaks', declared(1, 2)],
    ['revision zero', declared(0, 0)],
  ])('reads %s as undeclared, not as compatible', (_, declaration) => {
    expect(
      gatewayCompatibility('Cloud', declaration as Parameters<typeof gatewayCompatibility>[1], app)
        .kind
    ).toBe('undeclared');
  });

  it('is compatible with the switch-core built from the same registry', () => {
    const core = CONTRACTS['gateway-api']['switch-core'];
    expect(
      gatewayCompatibility('Local', declared(core.speaks, core.accepts), THIS_CONSOLE).kind
    ).toBe('compatible');
  });
});

import { describe, expect, it } from 'vitest';
import { managedTelemetryNotice } from './managed-telemetry-notice';

describe('managedTelemetryNotice', () => {
  it('says nothing while the stack is down', () => {
    expect(
      managedTelemetryNotice({
        running: false,
        deployed: { known: true, enabled: true },
        consent: false,
        sharedWithOthers: false,
      })
    ).toEqual({ kind: 'in-step' });
  });

  it('says nothing when nothing has been observed', () => {
    expect(
      managedTelemetryNotice({
        running: true,
        deployed: null,
        consent: true,
        sharedWithOthers: false,
      })
    ).toEqual({
      kind: 'in-step',
    });
  });

  it('says nothing when the server agrees with the user', () => {
    for (const consent of [true, false]) {
      expect(
        managedTelemetryNotice({
          running: true,
          deployed: { known: true, enabled: consent },
          consent,
          sharedWithOthers: false,
        })
      ).toEqual({ kind: 'in-step' });
    }
  });

  it('reports a server that has not picked up an opt-in', () => {
    expect(
      managedTelemetryNotice({
        running: true,
        deployed: { known: true, enabled: false },
        consent: true,
        sharedWithOthers: false,
      })
    ).toEqual({ kind: 'stale', consent: true });
  });

  // The direction that matters most: a server still reporting after the user
  // said no must not be reported as merely "out of date".
  it('reports a server still sharing after the user opted out', () => {
    expect(
      managedTelemetryNotice({
        running: true,
        deployed: { known: true, enabled: true },
        consent: false,
        sharedWithOthers: false,
      })
    ).toEqual({ kind: 'stale', consent: false });
  });

  it('reports an unreadable server as unknown rather than as agreeing', () => {
    expect(
      managedTelemetryNotice({
        running: true,
        deployed: { known: false, reason: 'ssh timed out' },
        consent: true,
        sharedWithOthers: false,
      })
    ).toEqual({ kind: 'unknown', reason: 'ssh timed out' });
  });

  it('does not offer to turn sharing on over others using the server', () => {
    expect(
      managedTelemetryNotice({
        running: true,
        deployed: { known: true, enabled: false },
        consent: true,
        sharedWithOthers: true,
      })
    ).toEqual({ kind: 'in-step' });
  });

  it('still offers to apply a no on a server others use', () => {
    expect(
      managedTelemetryNotice({
        running: true,
        deployed: { known: true, enabled: true },
        consent: false,
        sharedWithOthers: true,
      })
    ).toEqual({ kind: 'stale', consent: false });
  });
});

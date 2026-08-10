import { describe, expect, it } from 'vitest';
import { shouldCloseModalOnDismiss } from './dismissal';

describe('shouldCloseModalOnDismiss', () => {
  it('closes on outside-press when the modal allows it', () => {
    expect(
      shouldCloseModalOnDismiss({
        reason: 'outside-press',
        closeGuardActive: false,
        dismissOnOutsideClick: true,
      })
    ).toBe(true);
  });

  it('blocks outside-press when the modal opts out', () => {
    expect(
      shouldCloseModalOnDismiss({
        reason: 'outside-press',
        closeGuardActive: false,
        dismissOnOutsideClick: false,
      })
    ).toBe(false);
  });

  it('still closes on escape-key even when outside-click is disabled', () => {
    expect(
      shouldCloseModalOnDismiss({
        reason: 'escape-key',
        closeGuardActive: false,
        dismissOnOutsideClick: false,
      })
    ).toBe(true);
  });

  it('blocks both passive dismissals while the close guard is active', () => {
    expect(
      shouldCloseModalOnDismiss({
        reason: 'outside-press',
        closeGuardActive: true,
        dismissOnOutsideClick: true,
      })
    ).toBe(false);
    expect(
      shouldCloseModalOnDismiss({
        reason: 'escape-key',
        closeGuardActive: true,
        dismissOnOutsideClick: true,
      })
    ).toBe(false);
  });

  it('always closes on a deliberate close, regardless of flags', () => {
    for (const reason of ['close-press', 'imperative-action', 'trigger-press']) {
      expect(
        shouldCloseModalOnDismiss({
          reason,
          closeGuardActive: true,
          dismissOnOutsideClick: false,
        })
      ).toBe(true);
    }
  });
});

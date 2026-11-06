import { describe, expect, it } from 'vitest';
import { yourCloudView } from '@renderer/features/cloud-agents/your-cloud';
import { sharedCloudPresentation } from '@renderer/features/shared-cloud/shared-cloud-state';

// The PM's exact strings for people (the hosted UX stories, "Exact strings"),
// as Console shows them. Switch web uses the same words, so these must not
// drift: a change here is a change to the stories first.

const RESTING_EXPLANATION =
  'Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.';

describe('people words, the same as Switch web', () => {
  it('a resting cloud with agents explains itself in the PM’s words', () => {
    const view = yourCloudView(
      {
        room: null,
        awake: null,
        ai_calls_today: null,
        sleeping: true,
        stop_reason: 'idle',
        state: 'stopped',
        desired_state: 'stopped',
        agents: ['a1'],
      },
      () => ''
    );
    expect(view.resting && view.line).toBe(RESTING_EXPLANATION);
  });

  it('a resting agent reads "Resting · Wakes when you message it"', () => {
    const shown = sharedCloudPresentation(
      { agent_id: 'a1', state: 'resting' } as Parameters<typeof sharedCloudPresentation>[0],
      new Date(),
      false
    );
    expect(`${shown.label} · ${shown.detail}`).toBe('Resting · Wakes when you message it');
  });

  it('an agent that needs a login reads "Can’t reply right now · Check your AI login"', () => {
    const shown = sharedCloudPresentation(
      {
        agent_id: 'a1',
        state: 'unavailable',
        stop_reason: 'login_needed',
      } as Parameters<typeof sharedCloudPresentation>[0],
      new Date(),
      false
    );
    expect(`${shown.label} · ${shown.detail}`).toBe("Can't reply right now · Check your AI login");
  });
});

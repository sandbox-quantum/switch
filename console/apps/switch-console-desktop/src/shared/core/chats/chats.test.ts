import { describe, expect, it } from 'vitest';
import { chatAgentNaming } from './chats';

describe('chatAgentNaming', () => {
  it('names an agent without a display name by its unique name alone', () => {
    expect(chatAgentNaming({ name: 'helper', displayName: null }, false)).toEqual({
      label: 'helper',
      uniqueName: null,
    });
    expect(chatAgentNaming({ name: 'helper', displayName: 'helper' }, false)).toEqual({
      label: 'helper',
      uniqueName: null,
    });
    expect(chatAgentNaming({ name: 'helper', displayName: '  ' }, false)).toEqual({
      label: 'helper',
      uniqueName: null,
    });
  });

  it('keeps the unique name beside a display name that differs', () => {
    expect(chatAgentNaming({ name: 'deploy-bot', displayName: 'Deploy Helper' }, false)).toEqual({
      label: 'Deploy Helper',
      uniqueName: 'deploy-bot',
    });
    // Copying another agent's name as a display name still shows whose it is.
    expect(chatAgentNaming({ name: 'impostor', displayName: 'deploy-bot' }, false)).toEqual({
      label: 'deploy-bot',
      uniqueName: 'impostor',
    });
  });

  it('never shows another agent under a name that reads as switch-buddy', () => {
    for (const displayName of [
      'switch-buddy',
      'Switch Buddy',
      'SWITCH_BUDDY',
      'Your switch-buddy',
      'swítch-buddy',
      'switch-buddy @switch-buddy-ada',
    ])
      expect(chatAgentNaming({ name: 'helper', displayName }, false)).toEqual({
        label: 'helper',
        uniqueName: null,
      });
  });

  it('lets the person’s own buddy keep such a display name, with its unique name beside it', () => {
    expect(
      chatAgentNaming({ name: 'switch-buddy-ada', displayName: 'Switch Buddy' }, true)
    ).toEqual({ label: 'Switch Buddy', uniqueName: 'switch-buddy-ada' });
  });
});

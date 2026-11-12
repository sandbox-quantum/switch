import { describe, expect, it } from 'vitest';
import { buddyWelcomeMessage } from './buddy-welcome-message';

describe('buddyWelcomeMessage', () => {
  it('ties the name the buddy goes by to the switch-buddy the intro introduced', () => {
    const first = buddyWelcomeMessage({ firstName: 'Max', agentName: 'switch-buddy-max' }).split(
      '\n'
    )[0];
    expect(first).toBe(
      'Hi Max, I’m **switch-buddy-max**, your switch-buddy for everything Switch. 👋'
    );
  });

  it('does not say switch-buddy twice when that is its name', () => {
    const first = buddyWelcomeMessage({ firstName: null, agentName: 'switch-buddy' }).split(
      '\n'
    )[0];
    expect(first).toBe('Hi, I’m **switch-buddy**, your assistant for everything Switch. 👋');
  });
});

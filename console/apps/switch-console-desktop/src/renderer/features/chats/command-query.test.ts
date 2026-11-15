import { describe, expect, it } from 'vitest';
import { commandQuery, filterCommands } from './command-query';

const command = (name: string) => ({ name, description: name, usage: `!${name}` });

describe('commandQuery', () => {
  it('reads a command only at the start of the message, while its name is being typed', () => {
    expect(commandQuery('!', 1)).toEqual({ start: 0, query: '' });
    expect(commandQuery('!res', 4)).toEqual({ start: 0, query: 'res' });
    expect(commandQuery('!reset @helper', 14)).toBeNull();
    expect(commandQuery('hello !reset', 12)).toBeNull();
    expect(commandQuery('!reset', 0)).toBeNull();
  });
});

describe('filterCommands', () => {
  it('lists the commands a name starts first, then those containing it', () => {
    const commands = [command('help'), command('reset-all-agents'), command('reset')];
    expect(filterCommands(commands, 're').map((each) => each.name)).toEqual([
      'reset-all-agents',
      'reset',
    ]);
    expect(filterCommands(commands, 'all').map((each) => each.name)).toEqual(['reset-all-agents']);
    expect(filterCommands(commands, '')).toHaveLength(3);
  });
});

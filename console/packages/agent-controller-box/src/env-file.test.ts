import { describe, expect, it } from 'vitest';
import { parseEnvFile } from './env-file';
import { ConfigurationError } from './errors';

describe('parseEnvFile', () => {
  it('reads NAME=value lines, skipping comments and blanks, with export and quotes', () => {
    expect(
      parseEnvFile(
        [
          '# Vertex AI',
          'CLAUDE_CODE_USE_VERTEX=1',
          '',
          'export ANTHROPIC_VERTEX_PROJECT_ID=my-project',
          'CLOUD_ML_REGION="us-east5"',
          "NOTE='kept as is $HOME'",
          'QUOTED="say \\"hi\\""',
          'EMPTY=',
        ].join('\n'),
        'agents.env'
      )
    ).toEqual({
      CLAUDE_CODE_USE_VERTEX: '1',
      ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
      CLOUD_ML_REGION: 'us-east5',
      NOTE: 'kept as is $HOME',
      QUOTED: 'say "hi"',
      EMPTY: '',
    });
  });

  it('refuses what it would have to guess at, naming the line', () => {
    expect(() => parseEnvFile('A=1\nnot a line', 'agents.env')).toThrow(
      /agents\.env, line 2: expected NAME=value/
    );
    expect(() => parseEnvFile('A=two words', 'agents.env')).toThrow(/quote a value/);
    expect(() => parseEnvFile('A="open', 'agents.env')).toThrow(/closing " is missing/);
    expect(() => parseEnvFile('1A=x', 'agents.env')).toThrow(ConfigurationError);
  });
});

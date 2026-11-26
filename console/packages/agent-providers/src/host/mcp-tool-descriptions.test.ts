import { describe, expect, it } from 'vitest';
import { BRIEF_DESCRIPTION_MAX, briefDescription, describeToolsFor } from './mcp-tool-descriptions';

const POST_MESSAGE = {
  name: 'post_message',
  description:
    'Send a message to the connected room (broadcast, no specific recipient).\n\n' +
    'Args:\n    body: The message text to send. Plain string.\n\n' +
    'Returns:\n    {"event_id": "<event id>"} for the posted message.',
  inputSchema: { type: 'object', properties: { body: { type: 'string' } } },
};

describe('briefDescription', () => {
  it('keeps the first paragraph, on one line', () => {
    expect(briefDescription(POST_MESSAGE.description)).toBe(
      'Send a message to the connected room (broadcast, no specific recipient).'
    );
    expect(
      briefDescription("  Get a room's\n  timeline, grouped\n  into threads.\n\nArgs: …")
    ).toBe("Get a room's timeline, grouped into threads.");
    expect(briefDescription('')).toBe('');
  });

  it('cuts a long first paragraph at a word, and says it was cut', () => {
    const brief = briefDescription('word '.repeat(200));
    expect(brief.length).toBeLessThanOrEqual(BRIEF_DESCRIPTION_MAX);
    expect(brief).toMatch(/word…$/);
  });
});

describe('describeToolsFor', () => {
  it('gives Antigravity brief descriptions, and the schema as it is', () => {
    expect(describeToolsFor('antigravity')([POST_MESSAGE])).toEqual([
      {
        ...POST_MESSAGE,
        description: 'Send a message to the connected room (broadcast, no specific recipient).',
      },
    ]);
  });

  it('gives every other provider the tools as served', () => {
    for (const provider of ['claude', 'codex', 'opencode', 'cursor', 'mistral-vibe']) {
      const tools = [POST_MESSAGE];
      expect(describeToolsFor(provider)(tools)).toBe(tools);
    }
  });
});

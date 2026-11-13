import { describe, expect, it } from 'vitest';
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE, SWITCH_SKILL_NAME } from './index';

describe('switch skill', () => {
  it('declares the name its skills folder is given', () => {
    const name = /^---\n(?:.*\n)*?name:\s*"?([\w-]+)"?\s*$/m.exec(SWITCH_SKILL_FILE)?.[1];
    expect(name).toBe(SWITCH_SKILL_NAME);
  });

  it('gives context hosts the body without the frontmatter', () => {
    expect(SWITCH_SKILL_CONTEXT.startsWith('# Switch Room Workflow\n')).toBe(true);
    expect(SWITCH_SKILL_FILE.endsWith(SWITCH_SKILL_CONTEXT)).toBe(true);
  });

  it('describes messages Switch routes to the agent, and the room command behind them', () => {
    const text = SWITCH_SKILL_CONTEXT.replace(/\s+/g, ' ');
    expect(text).toContain('without tagging anyone, and Switch picked you to answer');
    expect(text).toContain('`!auto-route on`');
    expect(text).toContain('`!auto-route off`');
    expect(text).toMatch(/not really yours to answer.*stay silent/);
  });

  it("describes each workspace's decision service, the room notice and the triage agent", () => {
    const text = SWITCH_SKILL_CONTEXT.replace(/\s+/g, ' ');
    expect(text).toContain('Switch Console → Admin → Decision routing');
    expect(text).toContain('Auto-route is unavailable right now; tag an agent to reach it.');
    expect(text).toContain('`!auto-route fallback @agent`');
    expect(text).toContain('`!auto-route fallback off`');
    expect(text).toContain("came to you as the room's triage agent");
  });

  it('says where an untagged thread reply goes while the decision service is down', () => {
    const text = SWITCH_SKILL_CONTEXT.replace(/\s+/g, ' ');
    expect(text).toContain(
      "while the decision service is down, a reply in your thread that doesn't tag you reaches you only if you are the room's triage agent, and otherwise nobody"
    );
  });

  it('says who may turn auto-route on or off, and who may name the triage agent', () => {
    const text = SWITCH_SKILL_CONTEXT.replace(/\s+/g, ' ');
    expect(text).toContain(
      "The room's owner, a room admin or a workspace admin may turn it on or off"
    );
    expect(text).toContain(
      "The room's owner, a room admin or a workspace admin can name a triage agent for those messages"
    );
  });
});

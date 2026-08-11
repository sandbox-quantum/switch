import { describe, expect, it } from 'vitest';
import { OPENCODE_PLUGIN_CONTENT } from './plugin-file';

// The plugin is a source string dropped into a working directory, so nothing
// typechecks or lints it. These pin the properties whose failure mode is
// silent — the session simply stops reporting, with no error anywhere.
describe('OPENCODE_PLUGIN_CONTENT', () => {
  it('parses as JavaScript', () => {
    // `new Function` parses its argument as a function body, which accepts every
    // declaration this module uses once the ES export keyword is dropped. It
    // never runs — a syntax error is what we are looking for, and it is
    // otherwise only discoverable by launching a session and noticing silence.
    const asFunctionBody = OPENCODE_PLUGIN_CONTENT.replace(/^export /gm, '');
    expect(() => new Function(asFunctionBody)).not.toThrow();
  });

  it('exports the factory under the name the drop path installs', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toContain('export const SwitchdashNotifications');
  });

  it('posts to the hook server with the headers it reads back', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toContain('X-Switchdash-Token');
    expect(OPENCODE_PLUGIN_CONTENT).toContain('X-Switchdash-Pty-Id');
    expect(OPENCODE_PLUGIN_CONTENT).toContain('X-Switchdash-Event-Type');
    // The pre-cutover plugin used X-Emdash-*, which the hook server no longer
    // reads — every post would be dropped without a word.
    expect(OPENCODE_PLUGIN_CONTENT).not.toContain('Emdash');
  });

  it('reads the hook environment Switch Console actually sets', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toContain('SWITCHDASH_HOOK_PORT');
    expect(OPENCODE_PLUGIN_CONTENT).toContain('SWITCHDASH_HOOK_TOKEN');
    expect(OPENCODE_PLUGIN_CONTENT).toContain('SWITCHDASH_PTY_ID');
  });

  // OpenCode renders a plugin's stdout/stderr into the TUI, where it shows up
  // as artifacts around the input box. Logging must go through client.app.log.
  it('never writes to the console', () => {
    expect(OPENCODE_PLUGIN_CONTENT).not.toMatch(/console\s*\./);
    expect(OPENCODE_PLUGIN_CONTENT).toContain('client.app.log');
  });

  it('reports both turn boundaries and tool activity', () => {
    for (const type of ['start', 'stop', 'error', 'session', 'tool-use', 'tool-done']) {
      expect(OPENCODE_PLUGIN_CONTENT).toContain(`'${type}'`);
    }
    expect(OPENCODE_PLUGIN_CONTENT).toContain('tool.execute.before');
    expect(OPENCODE_PLUGIN_CONTENT).toContain('tool.execute.after');
  });

  // OpenCode re-emits the same user message after session.idle to attach final
  // stats. Gating on the role alone rebounds the session straight back to
  // working and it never reports completed again.
  it('gates turn start on a new user message id, not just the role', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toContain('lastTurnUserMessageId');
    expect(OPENCODE_PLUGIN_CONTENT).toContain('messageId !== lastTurnUserMessageId');
  });

  // A trailing idle outside a turn would otherwise report a turn that never ran.
  it('gates the completed report on a turn being open', () => {
    expect(OPENCODE_PLUGIN_CONTENT).toContain('if (working)');
  });

  it('no longer stands in for turn boundaries with an idle notification', () => {
    expect(OPENCODE_PLUGIN_CONTENT).not.toContain('idle_prompt');
  });
});

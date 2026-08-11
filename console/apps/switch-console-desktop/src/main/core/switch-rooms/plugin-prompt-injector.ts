import { getPlugin } from '@main/core/providers/plugin-registry';
import { buildPromptInjectionPayload } from '@shared/prompt-injection';
import type { PromptInjector } from './room-connection';

// Delay between writing the prompt text and the submit keystroke. Writing both
// in one PTY chunk makes TUIs (Claude) treat the trailing Enter as part of the
// pasted input, so the text lands in the box but is never sent. A provider that
// declares its own submitDelayMs overrides this.
const DEFAULT_SUBMIT_DELAY_MS = 150;

/**
 * Resolves a provider's keystroke-injection behavior from the plugin registry.
 * Shared: the local main process and the remote sidecar both construct this, so
 * a provider's submit sequence and delay are defined once.
 */
export class PluginPromptInjector implements PromptInjector {
  constructor(private readonly providerId: string) {}

  build(text: string): { payload: string; submitSequence: string; submitDelayMs: number } {
    const prompt = getPlugin(this.providerId).capabilities.prompt;
    const submitSequence = prompt.kind === 'keystroke' ? (prompt.submitSequence ?? '\r') : '\r';
    const submitDelayMs =
      (prompt.kind === 'keystroke' ? prompt.submitDelayMs : undefined) ?? DEFAULT_SUBMIT_DELAY_MS;
    const payload = buildPromptInjectionPayload(text);
    return { payload, submitSequence, submitDelayMs };
  }
}

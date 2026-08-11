import { buildPromptInjectionPayload } from '@shared/prompt-injection';

export { buildPromptInjectionPayload } from '@shared/prompt-injection';

type SendInput = (data: string) => Promise<unknown>;

type InjectPromptArgs = {
  text: string;
  sendInput: SendInput;
};

export async function pastePromptInjection(args: InjectPromptArgs): Promise<void> {
  const payload = buildPromptInjectionPayload(args.text);
  if (!payload) return;
  await args.sendInput(payload);
}

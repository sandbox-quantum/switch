// A Pi extension registering a model that answers the conformance prompts as
// a capable model would, for running the suite against real Pi without a model
// key. Pi resolves the import below from its own copy of pi-ai.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

const textOf = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part) => part.text ?? '').join('');

const call = (name, args) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

function answer(context) {
  const messages = context.messages;
  const last = messages.at(-1);
  if (last?.role === 'toolResult') {
    if (String(last.toolName).startsWith('mcp__'))
      return fauxAssistantMessage(`The tool returned: ${textOf(last)}`);
    return fauxAssistantMessage(last.isError ? 'declined' : 'done');
  }
  const prompt = textOf(last);
  let match;
  if (
    (match = /Create a file named (\S+) in the current directory containing exactly (\w+)/.exec(
      prompt
    ))
  )
    return call('write', { path: match[1], content: match[2] });
  if ((match = /Run the shell command: (.+?)\. (?:Then|If)/.exec(prompt)))
    return call('bash', { command: match[1] });
  if (
    (match = /Call the echo tool from the MCP server named (\S+) with the text (\w+)/.exec(prompt))
  )
    return call(`mcp__${match[1]}__switch_echo`, { text: match[2] });
  if ((match = /Count slowly from 1 to (\d+)/.exec(prompt)))
    return fauxAssistantMessage(
      Array.from({ length: Number(match[1]) }, (_, i) => `${i + 1}`).join('\n')
    );
  if ((match = /Reply with exactly (?:the text )?(\w+)/.exec(prompt)))
    return fauxAssistantMessage(match[1]);
  if (/What was the secret word/.test(prompt))
    for (const message of messages)
      if (message.role === 'user' && (match = /secret word: (\S+?)\./.exec(textOf(message))))
        return fauxAssistantMessage(match[1]);
  return fauxAssistantMessage('ok');
}

export default function scriptedModel(pi) {
  const faux = fauxProvider({
    provider: 'scripted',
    models: [{ id: 'conformance', name: 'Conformance' }],
    tokensPerSecond: 80,
  });
  faux.setResponses(Array.from({ length: 1000 }, () => answer));
  pi.registerProvider(faux.provider);
}

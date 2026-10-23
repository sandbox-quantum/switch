import type { ModelClient } from './model.ts';
import type { AgenticScenario } from './scenario-file.ts';

/**
 * The two model roles around the agent under test.
 *
 * The driver plays the human: given the scenario and the conversation so far,
 * it writes the human's next message, or says it is done. The judge reads the
 * finished conversation and grades it against the scenario's rubric, one
 * criterion at a time. Neither sees the other's prompt, and the judge never
 * sees the persona: it grades what was said, not what was meant.
 */

/**
 * One message in the conversation. `channel` is a message posted to the
 * channel without addressing the agent (a scenario's setup messages): part of
 * what the agent could read, not something it was asked.
 */
export interface Turn {
  from: 'human' | 'agent' | 'channel';
  text: string;
}

const LABEL: Record<Turn['from'], string> = {
  human: 'human, to the agent',
  agent: 'agent',
  channel: 'channel, earlier, not addressed to the agent',
};

/**
 * The prompts' versions, recorded in every report so a verdict can be traced
 * to the prompt that produced it. Bump one with any change to that role's
 * prompt; `agentic.test.ts` pins a hash of each, so a change that forgets to
 * fails there.
 */
export const DRIVER_VERSION = 1;
export const JUDGE_VERSION = 1;

/** What the driver answers when the human has nothing more to say. */
export const DONE = 'DONE';

export const DRIVER_SYSTEM = `You play a human in a team chat channel, talking to an AI agent that is a member of the channel. You are testing nothing and know nothing about tests: you are the person described, with the goal described.

Write only the next message you would send: plain text, as you would type it in chat, with no quotation marks, no name prefix and no @mention (one is added for you). Keep it short and natural.

If your goal is met, or the agent has made clear it cannot help further, reply with exactly ${DONE} and nothing else.`;

export const JUDGE_SYSTEM = `You grade a conversation between a human and an AI agent in a team chat channel against a list of criteria. Judge only what the transcript shows. Grade each criterion on its own: one failure does not fail the others. If the transcript does not show enough to decide a criterion, it fails.

Answer with JSON only, no prose and no code fence, in exactly this shape:
{"verdicts": [{"id": "<criterion id>", "pass": true, "reason": "<one sentence>"}]}
with one entry per criterion, in the order given.`;

export function transcriptText(turns: readonly Turn[]): string {
  return turns.map((turn) => `[${LABEL[turn.from]}] ${turn.text}`).join('\n\n');
}

export function driverPrompt(scenario: AgenticScenario, turns: readonly Turn[]): string {
  const humanTurns = turns.filter((turn) => turn.from === 'human').length;
  return [
    `Who you are:\n${scenario.persona}`,
    `Your goal:\n${scenario.goal}`,
    `The conversation so far:\n${transcriptText(turns)}`,
    `You have sent ${humanTurns} of at most ${scenario.maxTurns} messages. Write your next message, or ${DONE}.`,
  ].join('\n\n');
}

export function judgePrompt(scenario: AgenticScenario, turns: readonly Turn[]): string {
  return [
    `What the human wanted:\n${scenario.goal}`,
    `Criteria:\n${scenario.rubric.map((item) => `- ${item.id}: ${item.criterion}`).join('\n')}`,
    `Transcript:\n${transcriptText(turns)}`,
  ].join('\n\n');
}

export async function driverTurn(
  client: ModelClient,
  model: string,
  maxUsd: number,
  scenario: AgenticScenario,
  turns: readonly Turn[]
): Promise<{ message: string | null; costUsd: number }> {
  const answer = await client.ask({
    model,
    maxUsd,
    system: DRIVER_SYSTEM,
    prompt: driverPrompt(scenario, turns),
  });
  const message = answer.text.replace(/^["“]|["”]$/g, '').trim();
  return { message: message === DONE || message === '' ? null : message, costUsd: answer.costUsd };
}

export interface Verdict {
  id: string;
  pass: boolean;
  reason: string;
}

export type Judgement =
  | { ok: true; verdicts: Verdict[]; costUsd: number }
  | { ok: false; error: string; raw: string; costUsd: number };

export async function judge(
  client: ModelClient,
  model: string,
  maxUsd: number,
  scenario: AgenticScenario,
  turns: readonly Turn[]
): Promise<Judgement> {
  const answer = await client.ask({
    model,
    maxUsd,
    system: JUDGE_SYSTEM,
    prompt: judgePrompt(scenario, turns),
  });
  const parsed = parseVerdicts(
    answer.text,
    scenario.rubric.map((item) => item.id)
  );
  return parsed.ok
    ? { ok: true, verdicts: parsed.verdicts, costUsd: answer.costUsd }
    : { ok: false, error: parsed.error, raw: answer.text, costUsd: answer.costUsd };
}

/** The judge's verdicts, held to the rubric: one per criterion, each a boolean with a reason. */
export function parseVerdicts(
  raw: string,
  ids: readonly string[]
): { ok: true; verdicts: Verdict[] } | { ok: false; error: string } {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end < start) return { ok: false, error: 'the judge answered without JSON' };
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: `the judge's JSON does not parse: ${String(error)}` };
  }
  const list = (value as { verdicts?: unknown }).verdicts;
  if (!Array.isArray(list)) return { ok: false, error: "the judge's JSON has no 'verdicts' list" };
  const verdicts: Verdict[] = [];
  for (const entry of list) {
    const item = entry as Record<string, unknown> | null;
    if (
      item === null ||
      typeof item.id !== 'string' ||
      typeof item.pass !== 'boolean' ||
      typeof item.reason !== 'string'
    ) {
      return { ok: false, error: `a verdict is not {id, pass, reason}: ${JSON.stringify(entry)}` };
    }
    verdicts.push({ id: item.id, pass: item.pass, reason: item.reason });
  }
  const given = verdicts.map((verdict) => verdict.id);
  const missing = ids.filter((id) => !given.includes(id));
  const extra = given.filter((id) => !ids.includes(id));
  if (missing.length > 0 || extra.length > 0 || given.length !== ids.length) {
    return {
      ok: false,
      error: `the verdicts do not match the rubric (missing: ${missing.join(', ') || 'none'}; unknown or repeated: ${extra.join(', ') || 'none'})`,
    };
  }
  return { ok: true, verdicts: ids.map((id) => verdicts.find((verdict) => verdict.id === id)!) };
}

import type {
  LaunchProfileHostExec,
  LaunchProfileModel,
} from '@switch-console/core/agents/plugins';

/**
 * Ask the installed OpenCode what models this agent can use.
 *
 * `--verbose` is what carries each model's variants, which is the whole reason
 * for asking: a variant is not a fixed list, it is whatever the chosen model
 * declares, so the only way to offer the right ones is to read them off the
 * host. The command also honours `OPENCODE_CONFIG`, so pointing it at an agent's
 * own config reports what *that* agent can reach, including a provider only it
 * declares.
 */
export const OPENCODE_MODELS_ARGS = ['models', '--verbose'];

/**
 * Parse `opencode models --verbose`.
 *
 * The output is a `provider/model` line followed by a pretty-printed JSON object
 * per model, not a JSON document — OpenCode has no machine-readable flag for
 * this. Blocks are delimited by a `{` and a `}` alone on a line, which is what
 * the pretty-printer emits at the top level and never for a nested object, since
 * those are indented.
 *
 * The header line is ignored in favour of the `providerID` and `id` inside the
 * block: the same information, from the part of the output that is structured.
 *
 * Deliberately tolerant. A block that does not parse, or that is cut off at the
 * end, is skipped rather than failing the whole catalogue — a model we cannot
 * read is one we cannot offer, which is not a reason to stop offering the rest.
 * A caller that gets nothing back should treat the catalogue as unavailable and
 * say so, rather than concluding the host has no models.
 */
/**
 * The models this host offers, with each one's reasoning variants.
 *
 * Throws when the output yields nothing usable. That is the honest reading: the
 * command not being there, failing, or printing something this cannot parse are
 * all "we could not ask", and none of them mean the host has no models — which
 * is what an empty list would say, and would flag every valid model as wrong.
 */
export async function opencodeLaunchProfileModels(
  exec: LaunchProfileHostExec
): Promise<LaunchProfileModel[]> {
  const { stdout } = await exec('opencode', OPENCODE_MODELS_ARGS);
  const models = parseOpencodeModels(stdout);
  if (models.length === 0) {
    throw new Error('`opencode models --verbose` returned no models this app could read.');
  }
  return models;
}

export function parseOpencodeModels(stdout: string): LaunchProfileModel[] {
  const models: LaunchProfileModel[] = [];
  let block: string[] | null = null;

  for (const line of stdout.split('\n')) {
    if (line === '{') {
      block = [line];
      continue;
    }
    if (block === null) continue;

    block.push(line);
    if (line !== '}') continue;

    const model = readModel(block.join('\n'));
    if (model) models.push(model);
    block = null;
  }

  return models;
}

function readModel(raw: string): LaunchProfileModel | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const { providerID, id, variants } = parsed as {
    providerID?: unknown;
    id?: unknown;
    variants?: unknown;
  };
  if (typeof providerID !== 'string' || typeof id !== 'string') return null;
  if (!providerID || !id) return null;

  return {
    // The form's model field takes `provider/model`, so the catalogue is keyed
    // the same way and a typed value can be compared to it directly.
    id: `${providerID}/${id}`,
    variants:
      typeof variants === 'object' && variants !== null && !Array.isArray(variants)
        ? Object.keys(variants)
        : [],
  };
}

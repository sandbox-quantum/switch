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
 * The models this host offers, with each one's reasoning variants, asked the
 * way the installed OpenCode answers.
 *
 * Throws when the output yields nothing usable. That is the honest reading: the
 * command not being there, failing, or printing something this cannot parse are
 * all "we could not ask", and none of them mean the host has no models — which
 * is what an empty list would say, and would flag every valid model as wrong.
 */
export async function opencodeLaunchProfileModels(
  exec: LaunchProfileHostExec
): Promise<LaunchProfileModel[]> {
  const { stdout: version } = await exec('opencode', ['--version']);
  const major = Number.parseInt(version.match(/(?<![\d.])(\d+)\.\d+\.\d+/)?.[1] ?? '', 10);
  if (Number.isNaN(major))
    throw new Error(`\`opencode --version\` printed no version: ${JSON.stringify(version.trim())}`);
  const [args, parse] =
    major >= 2
      ? [OPENCODE2_MODELS_ARGS, parseOpencode2Models]
      : [OPENCODE_MODELS_ARGS, parseOpencodeModels];
  const { stdout } = await exec('opencode', args);
  const models = parse(stdout);
  if (models.length === 0) {
    throw new Error(`\`opencode ${args.join(' ')}\` returned no models this app could read.`);
  }
  return models;
}

/**
 * OpenCode 2 dropped `models --verbose`; its API lists the same catalogue as
 * JSON, variants included. `--standalone` answers from a private server, so
 * asking neither starts nor reaches the person's background service, and it
 * honours `OPENCODE_CONFIG` as 1.x does.
 */
export const OPENCODE2_MODELS_ARGS = ['api', '--standalone', 'model.list'];

/**
 * Parse `opencode api model.list`. Unlike the 1.x output this is one JSON
 * document, so output that is not one is an error rather than a model to skip.
 * A model OpenCode reports as disabled is not offered.
 */
export function parseOpencode2Models(stdout: string): LaunchProfileModel[] {
  const { data } = JSON.parse(stdout) as { data?: unknown };
  if (!Array.isArray(data)) throw new Error('`opencode api model.list` returned no model list.');
  return data.flatMap((entry): LaunchProfileModel[] => {
    const { providerID, id, variants, enabled } = entry as {
      providerID?: unknown;
      id?: unknown;
      variants?: unknown;
      enabled?: unknown;
    };
    if (typeof providerID !== 'string' || typeof id !== 'string' || !providerID || !id) return [];
    if (enabled === false) return [];
    return [
      {
        id: `${providerID}/${id}`,
        variants: Array.isArray(variants)
          ? variants.flatMap((variant) => {
              const name = (variant as { id?: unknown } | null)?.id;
              return typeof name === 'string' ? [name] : [];
            })
          : [],
      },
    ];
  });
}

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

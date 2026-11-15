import type { ModelCatalogueResult } from '@renderer/features/locations/components/agent-model-catalogue';

/**
 * The models asked of the machine from here, squared with what the machine
 * itself reports of the provider: that report is what the agent runs on and
 * what Add agent showed, so a check from here that disagrees does not overrule it.
 */
export function catalogueAsReported(
  asked: ModelCatalogueResult | undefined,
  machineName: string,
  provider: string,
  reported: { ready: boolean; problem: string | null } | undefined
): ModelCatalogueResult | undefined {
  if (reported && !reported.ready)
    return {
      kind: 'unavailable',
      reason: `${machineName} reports ${provider} ${reported.problem ?? 'not ready'}. You can enter a model ID.`,
    };
  if (asked?.kind === 'unavailable' && reported?.ready)
    return {
      kind: 'unavailable',
      reason: `${machineName} reports ${provider} ready, but its models could not be listed from here (${asked.reason}). You can enter a model ID.`,
    };
  return asked;
}

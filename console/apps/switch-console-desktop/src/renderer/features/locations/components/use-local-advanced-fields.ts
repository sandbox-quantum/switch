import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAdvancedConfigSchema } from '@renderer/features/managed-agents/use-managed-agents';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { type AgentProviderId, getProvider } from '@shared/core/providers/agent-provider-registry';
import {
  type LocalAdvancedFields,
  localAdvancedFields,
  onlyModel,
  type ServerFields,
} from './local-advanced-fields';

/** The advanced configuration fields of an agent of `providerId` on the server `serverId`. */
export function useLocalAdvancedFields(
  serverId: string | null,
  providerId: AgentProviderId | null
): LocalAdvancedFields {
  const settingsQuery = useQuery({
    queryKey: ['agentAdvancedSettings', providerId],
    queryFn: () => rpc.agents.advancedSettings({ providerId: providerId! }),
    enabled: providerId !== null,
  });
  const schemaQuery = useAdvancedConfigSchema(providerId === null ? null : serverId);
  const settings = settingsQuery.data;
  const schema = schemaQuery.data;
  const schemaError = schemaQuery.error;
  // Memoised on what it is built from, so a form that resets when its fields
  // change is not reset on every render.
  return useMemo((): LocalAdvancedFields => {
    if (!providerId || !settings) return { surface: undefined, fields: [], problem: null };
    const server: ServerFields =
      serverId === null
        ? { kind: 'no-server' }
        : schemaError
          ? {
              kind: 'error',
              message: failureText(
                schemaError,
                `The Switch server’s advanced configuration fields could not be read${onlyModel(settings)}.`
              ),
            }
          : schema
            ? { kind: 'schema', schema }
            : { kind: 'loading' };
    return {
      surface: settings.surface,
      ...localAdvancedFields(
        { id: providerId, label: getProvider(providerId)?.name ?? providerId },
        settings,
        server
      ),
    };
  }, [providerId, serverId, settings, schema, schemaError]);
}

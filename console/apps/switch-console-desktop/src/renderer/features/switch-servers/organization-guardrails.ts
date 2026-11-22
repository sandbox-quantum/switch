import { dashboardPageUrl, type SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { administersOrganization, type Workspace } from '@shared/core/workspaces/workspaces';

/**
 * Where the operator goes once a server's guardrails are each organization's
 * own: the guardrails page of the organization `workspace` belongs to, in
 * that workspace. The page is its organization's admins' alone, so it is
 * offered only to one of them; anyone else is told why it isn't.
 */
export type OrganizationGuardrailsWay =
  | { kind: 'open'; url: string }
  | { kind: 'not-an-admin'; text: string };

export function organizationGuardrailsWay(
  server: Pick<SwitchServer, 'url' | 'dashboardUrl'>,
  workspace: Workspace | null
): OrganizationGuardrailsWay {
  if (workspace !== null && workspace.tenantId !== null && administersOrganization(workspace))
    return {
      kind: 'open',
      url: dashboardPageUrl(server, 'settings/org/guardrails', workspace.tenantId),
    };
  const organization = workspace?.organizationName ?? 'this organization';
  return {
    kind: 'not-an-admin',
    text: `Only ${organization}'s admins can set its guardrails, in its organization settings, and you aren't one of them.`,
  };
}

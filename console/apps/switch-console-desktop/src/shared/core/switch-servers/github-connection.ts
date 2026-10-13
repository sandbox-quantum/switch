import { z } from 'zod';

export const gitHubConnectionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_connected'), install_url: z.string() }),
  z.object({
    status: z.literal('connected'),
    login: z.string(),
    install_url: z.string(),
    installations: z.array(
      z.object({
        id: z.number(),
        account: z.string(),
        repositories: z.array(z.object({ id: z.number(), name: z.string() })),
      })
    ),
    /**
     * Organizations whose single sign-on hides their installations from this
     * sign-in; connecting again and authorizing them shows those. Absent from
     * a server from before it.
     */
    sso_hidden_organizations: z.array(z.number()).optional(),
  }),
]);
export type GitHubConnection = z.infer<typeof gitHubConnectionSchema>;
export const gitHubFlowSchema = z.object({
  status: z.enum(['pending', 'checking', 'ready', 'failed']),
  login: z.string(),
});
export type GitHubFlow = z.infer<typeof gitHubFlowSchema>;

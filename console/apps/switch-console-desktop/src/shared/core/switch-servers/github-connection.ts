import { z } from 'zod';

export const gitHubConnectionSchema = z.discriminatedUnion('status', [
  /**
   * `install_url` is null where the server has no GitHub App set up, so only
   * a pasted token connects GitHub there.
   */
  z.object({ status: z.literal('not_connected'), install_url: z.string().nullable() }),
  z.object({
    status: z.literal('connected'),
    /**
     * How it was connected: through the App's sign-in (`oauth`), or with a
     * pasted personal access token (`token`), which reaches no installations.
     * Absent from a server from before tokens.
     */
    method: z.string().optional(),
    login: z.string(),
    install_url: z.string().nullable(),
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
  status: z.enum(['pending', 'checking', 'connected', 'failed']),
  login: z.string(),
  error: z.string().nullable(),
  warning: z.string().nullable(),
});
export type GitHubFlow = z.infer<typeof gitHubFlowSchema>;

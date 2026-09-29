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
  }),
]);
export type GitHubConnection = z.infer<typeof gitHubConnectionSchema>;
export const gitHubFlowSchema = z.object({
  status: z.enum(['pending', 'checking', 'ready', 'failed']),
  login: z.string(),
});
export type GitHubFlow = z.infer<typeof gitHubFlowSchema>;

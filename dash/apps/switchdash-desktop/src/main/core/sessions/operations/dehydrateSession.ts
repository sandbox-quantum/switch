import { resolveSessionAgent } from '../../projects/utils';

export async function dehydrateSession(projectId: string, sessionId: string): Promise<void> {
  const agent = resolveSessionAgent(projectId, sessionId);
  await agent?.dehydrate();
}

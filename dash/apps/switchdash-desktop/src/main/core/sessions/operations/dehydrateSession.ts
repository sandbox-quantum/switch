import { resolveSession } from '../../projects/utils';

export async function dehydrateSession(projectId: string, sessionId: string): Promise<void> {
  const session = resolveSession(projectId, sessionId);
  await session?.agent.dehydrate();
}

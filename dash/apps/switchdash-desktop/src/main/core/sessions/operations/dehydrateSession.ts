import { resolveSession } from '../../locations/utils';

export async function dehydrateSession(sessionId: string): Promise<void> {
  const session = resolveSession(sessionId);
  await session?.agent.dehydrate();
}

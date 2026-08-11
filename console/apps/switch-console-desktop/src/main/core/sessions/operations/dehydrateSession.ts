import { resolveSessionAgent } from '../../locations/utils';

export async function dehydrateSession(sessionId: string): Promise<void> {
  const agent = resolveSessionAgent(sessionId);
  await agent?.dehydrate();
}

import { desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import { type Session } from '@shared/core/sessions/sessions';
import { mapSessionRowToSession } from '../utils/utils';

export async function getSessions(locationId?: string): Promise<Session[]> {
  const base = db
    .select({ session: sessions, providerId: agents.providerId, name: agents.name })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id));

  const rows = locationId
    ? await base.where(eq(agents.locationId, locationId)).orderBy(desc(sessions.updatedAt))
    : await base.orderBy(desc(sessions.updatedAt));

  return rows.map(({ session, providerId, name }) =>
    mapSessionRowToSession(session, providerId, name)
  );
}

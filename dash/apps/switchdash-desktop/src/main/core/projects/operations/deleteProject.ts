import { eq } from 'drizzle-orm';
import { projectEvents } from '@main/core/projects/project-events';
import { projectManager } from '@main/core/projects/project-manager';
import { getSessions } from '@main/core/sessions/operations/getSessions';
import { sessionRuntimeManager } from '@main/core/sessions/session-runtime-manager';
import { viewStateService } from '@main/core/view-state/view-state-service';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';

export async function deleteProject(id: string): Promise<void> {
  const provider = projectManager.getProject(id);
  if (provider) {
    const projectSessions = await getSessions(id);
    await Promise.allSettled([
      ...projectSessions.map((t) => sessionRuntimeManager.teardownSession(t.id)),
      ...projectSessions.map((t) => viewStateService.del(`session:${t.id}`)),
    ]);
    await projectManager.closeProject(id);
  }

  await db.delete(projects).where(eq(projects.id, id));
  void viewStateService.del(`project:${id}`);
  projectEvents._emit('project:deleted', id);
}

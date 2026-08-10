import { useCurrentViewId, useParams } from '@renderer/lib/layout/navigation-provider';

export function useIsActiveSession(sessionId: string): boolean {
  // Deliberately not useWorkspaceSlots: this hook is reachable from the session
  // view, so loading the view registry here would make the registry depend on
  // its own members being initialised first.
  const currentView = useCurrentViewId();
  const { params } = useParams('session');
  return currentView === 'session' && params.sessionId === sessionId;
}

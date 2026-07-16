import { runInAction } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useEffect, type ReactNode } from 'react';
import { appState } from '@renderer/lib/stores/app-state';

export const WorkspaceViewProvider = observer(function WorkspaceViewProvider({
  children,
}: {
  children: ReactNode;
}) {
  const currentViewId = appState.navigation.currentViewId;

  useEffect(() => {
    runInAction(() => {
      appState.navigation.isNavigating = false;
    });
  }, [currentViewId]);

  return <>{children}</>;
});

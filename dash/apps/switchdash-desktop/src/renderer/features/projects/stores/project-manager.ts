import { err, ok } from '@switchdash/shared';
import { makeObservable, observable, runInAction } from 'mobx';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { viewStateCache } from '@renderer/lib/stores/view-state-cache';
import { type LocalProject } from '@shared/projects';
import type { ProjectViewSnapshot } from '@shared/view-state';
import {
  createUnmountedProject,
  createUnregisteredProject,
  isUnmountedProject,
  isUnregisteredProject,
  type ProjectStore,
  type UnregisteredProjectPhase,
} from './project';
import type {
  ModeData,
  ProjectCreationCompletion,
  ProjectCreationError,
  ProjectType,
  StartProjectCreationOptions,
  StartProjectCreationResult,
} from './project-creation-types';

export class ProjectManagerStore {
  projects = observable.map<string, ProjectStore>();
  pendingCreationIds = observable.set<string>();
  private _projectMountPromises = new Map<string, Promise<void>>();
  private _loadPromise: Promise<void> | null = null;

  constructor() {
    makeObservable(this, { projects: observable, pendingCreationIds: observable });
  }

  load(): Promise<void> {
    if (!this._loadPromise) {
      this._loadPromise = this._doLoad();
    }
    return this._loadPromise;
  }

  private async _doLoad(): Promise<void> {
    const rawProjects = await rpc.projects.getProjects();
    const toMount: string[] = [];
    runInAction(() => {
      for (const p of rawProjects) {
        if (this.projects.has(p.id)) continue;
        this.projects.set(p.id, createUnmountedProject(p, 'idle'));
        toMount.push(p.id);
      }
    });
    await Promise.allSettled(toMount.map((id) => this.mountProject(id)));
  }

  async createProject(
    projectType: ProjectType,
    data: ModeData,
    id?: string
  ): Promise<string | undefined> {
    const result = await this.startProjectCreation(projectType, data, { id });
    if (result.kind === 'existing') return result.projectId;

    const completion = await result.completion;
    return completion.success ? result.projectId : undefined;
  }

  async startProjectCreation(
    projectType: ProjectType,
    data: ModeData,
    options: StartProjectCreationOptions = {}
  ): Promise<StartProjectCreationResult> {
    const projectId = options.id ?? crypto.randomUUID();
    // Remote agents have no local directory: skip the local path inspection /
    // existing-project dedup and create straight away (create-local-project
    // detects + validates the agent in the remote dir over SSH).
    const targetPath = data.remoteConfig
      ? undefined
      : data.mode === 'pick'
        ? data.path
        : `${data.path}/${data.name}`;
    if (targetPath !== undefined) {
      const inspection = await rpc.projects.inspectProjectPath({ type: 'local', path: targetPath });
      if (inspection.existingProject) {
        return { kind: 'existing', projectId: inspection.existingProject.id };
      }
    }

    runInAction(() => {
      this.pendingCreationIds.add(projectId);
      this.projects.set(
        projectId,
        createUnregisteredProject(projectId, data.name, initialCreationPhase(data.mode), data.mode)
      );
    });

    const completion = this._doCreateProject(projectType, data, projectId, targetPath).finally(
      () => {
        runInAction(() => this.pendingCreationIds.delete(projectId));
      }
    );

    return { kind: 'creating', projectId, completion };
  }

  private async _doCreateProject(
    _projectType: ProjectType,
    data: ModeData,
    projectId: string,
    targetPath: string | undefined
  ): Promise<ProjectCreationCompletion> {
    let result: ProjectCreationCompletion;
    try {
      const projectResult = await rpc.projects.createProject({
        type: 'local',
        id: projectId,
        path: targetPath,
        name: data.name,
        serverId: data.serverId,
        providerId: data.providerId,
        remoteConfig: data.remoteConfig,
      });
      if (!projectResult.success) {
        result = err(projectResult.error);
      } else {
        this._setAndOpenProject(projectId, projectResult.data);
        result = ok();
      }
    } catch (error) {
      this._markUnexpectedCreationError(projectId, error);
      throw error;
    }

    if (!result.success) this._markCreationError(projectId, result.error);
    return result;
  }

  mountProject(projectId: string): Promise<void> {
    const inFlight = this._projectMountPromises.get(projectId);
    if (inFlight) return inFlight;

    const project = this.projects.get(projectId);
    if (!project || !isUnmountedProject(project)) return Promise.resolve();

    runInAction(() => {
      project.phase = 'opening';
      project.error = undefined;
      project.errorCode = undefined;
    });

    const promise = Promise.all([
      rpc.projects.openProject(projectId),
      viewStateCache.get(`project:${projectId}`),
    ])
      .then(async ([openResult, savedSnapshot]) => {
        if (!openResult.success) {
          runInAction(() => {
            const current = this.projects.get(projectId);
            if (current && isUnmountedProject(current)) {
              current.phase = 'error';
              if (openResult.error.type === 'path-not-found') {
                current.error = openResult.error.path;
                current.errorCode = 'path-not-found';
              } else if (openResult.error.type === 'error') {
                current.error = openResult.error.message;
                current.errorCode = undefined;
              } else {
                current.error = undefined;
                current.errorCode = undefined;
              }
            }
          });
          return;
        }
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            // Patch repositoryWorkspaceId from the main process response so the
            // mounted project data is up-to-date (fixes stale null after creation).
            const projectData = current.data;
            if (openResult.data.repositoryWorkspaceId && projectData) {
              projectData.repositoryWorkspaceId = openResult.data.repositoryWorkspaceId;
            }
            current.transitionToMounted(
              projectData,
              savedSnapshot as ProjectViewSnapshot | undefined
            );
          }
        });
        // Load the session list before provisioning so the sessions map is populated.
        const sessionManager = this.projects.get(projectId)?.mountedProject?.sessionManager;
        if (sessionManager) {
          await sessionManager.loadSessions();
          const nav = appState.navigation;
          const navParams = nav.viewParamsStore['session'] as
            | { projectId?: string; sessionId?: string }
            | undefined;
          const navSessionId =
            nav.currentViewId === 'session' && navParams?.projectId === projectId
              ? navParams.sessionId
              : undefined;
          if (navSessionId) {
            sessionManager.provisionSession(navSessionId).catch(() => {});
          }
        }
      })
      .catch((err: unknown) => {
        runInAction(() => {
          const current = this.projects.get(projectId);
          if (current && isUnmountedProject(current)) {
            current.phase = 'error';
            current.error = err instanceof Error ? err.message : String(err);
            current.errorCode = undefined;
          }
        });
        throw err;
      })
      .finally(() => {
        this._projectMountPromises.delete(projectId);
      });

    this._projectMountPromises.set(projectId, promise);
    return promise;
  }

  async deleteProject(projectId: string): Promise<void> {
    const snapshot = this.projects.get(projectId);
    runInAction(() => {
      this.projects.delete(projectId);
    });
    appState.navigation.revalidate();
    try {
      await rpc.projects.deleteProject(projectId);
    } catch (err) {
      runInAction(() => {
        if (snapshot) this.projects.set(projectId, snapshot);
      });
      throw err;
    }
  }

  removeUnregisteredProject(projectId: string): void {
    runInAction(() => {
      const store = this.projects.get(projectId);
      if (store && isUnregisteredProject(store)) {
        this.projects.delete(projectId);
      }
    });
  }

  private _setAndOpenProject(id: string, project: LocalProject): void {
    runInAction(() => {
      const current = this.projects.get(id);
      if (current) {
        current.transitionToUnmounted(project, 'opening');
      } else {
        this.projects.set(id, createUnmountedProject(project, 'opening'));
      }
    });
    void this.mountProject(id);
  }

  private _markCreationError(id: string, error: ProjectCreationError): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) {
        store.phase = 'error';
        store.error = creationErrorMessage(error);
      }
    });
  }

  private _markUnexpectedCreationError(id: string, error: unknown): void {
    runInAction(() => {
      const store = this.projects.get(id);
      if (store && isUnregisteredProject(store)) {
        store.phase = 'error';
        store.error = error instanceof Error ? error.message : String(error);
      }
    });
  }
}

function creationErrorMessage(error: ProjectCreationError): string {
  switch (error.type) {
    case 'not-repository':
      return 'Directory is not a git repository. Enable "Initialize git repository" to continue.';
    case 'switch-agent-not-on-server':
      return `This agent isn't registered on ${error.serverName}. Pick the server it belongs to.`;
    case 'switch-server-unauthenticated':
      return `Sign in to ${error.serverName} before adding this agent.`;
    default:
      return error.message;
  }
}

function initialCreationPhase(_mode: ModeData['mode']): UnregisteredProjectPhase {
  return 'registering';
}

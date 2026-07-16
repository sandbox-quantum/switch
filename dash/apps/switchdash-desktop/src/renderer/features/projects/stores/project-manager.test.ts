import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProject } from '@shared/projects';
import { isUnregisteredProject } from './project';
import { ProjectManagerStore } from './project-manager';

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  inspectProjectPath: vi.fn(),
  openProject: vi.fn(),
  eventOn: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: mocks.eventOn,
  },
  rpc: {
    projects: {
      createProject: mocks.createProject,
      getProjects: vi.fn(async () => []),
      inspectProjectPath: mocks.inspectProjectPath,
      openProject: mocks.openProject,
    },
  },
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      currentViewId: 'home',
      revalidate: vi.fn(),
      viewParamsStore: {},
    },
  },
}));

vi.mock('@renderer/lib/stores/view-state-cache', () => ({
  viewStateCache: {
    get: vi.fn(async () => undefined),
  },
}));

function localProject(overrides: Partial<LocalProject> = {}): LocalProject {
  return {
    type: 'local',
    id: 'project-id',
    name: 'Project',
    path: '/project',
    repositoryWorkspaceId: null,
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    ...overrides,
  };
}

function okProject(project: LocalProject) {
  return { success: true as const, data: project };
}

describe('ProjectManagerStore project creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.inspectProjectPath.mockResolvedValue({ isDirectory: true, isGitRepo: true });
    mocks.createProject.mockResolvedValue(okProject(localProject()));
    mocks.openProject.mockReturnValue(new Promise(() => {}));
  });

  it('returns an existing project without starting creation', async () => {
    const existingProject = localProject({ id: 'existing-project' });
    mocks.inspectProjectPath.mockResolvedValueOnce({
      isDirectory: true,
      isGitRepo: true,
      existingProject,
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'pick',
        name: 'Project',
        path: '/project',
        serverId: 'server-1',
        providerId: 'claude',
      },
      { id: 'optimistic-project' }
    );

    expect(result).toEqual({ kind: 'existing', projectId: 'existing-project' });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(store.projects.has('optimistic-project')).toBe(false);
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(false);
  });

  it('creates unregistered project state before returning creating', async () => {
    let resolveCreateProject: (project: LocalProject) => void = () => {};
    mocks.createProject.mockReturnValueOnce(
      new Promise<ReturnType<typeof okProject>>((resolve) => {
        resolveCreateProject = (project) => resolve(okProject(project));
      })
    );
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'pick',
        name: 'Project',
        path: '/project',
        serverId: 'server-1',
        providerId: 'claude',
      },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    const pendingProject = store.projects.get('optimistic-project');
    expect(pendingProject && isUnregisteredProject(pendingProject)).toBe(true);
    expect(pendingProject?.phase).toBe('registering');
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(true);
    expect(mocks.inspectProjectPath).toHaveBeenCalledTimes(1);

    resolveCreateProject(localProject({ id: 'optimistic-project' }));
    if (result.kind === 'creating') await result.completion;

    expect(mocks.inspectProjectPath).toHaveBeenCalledTimes(1);
    expect(store.pendingCreationIds.has('optimistic-project')).toBe(false);
  });

  it('marks project creation as failed when the project RPC returns a typed error', async () => {
    mocks.createProject.mockResolvedValueOnce({
      success: false,
      error: {
        type: 'not-repository',
        path: '/project',
      },
    });
    const store = new ProjectManagerStore();

    const result = await store.startProjectCreation(
      { type: 'local' },
      {
        mode: 'pick',
        name: 'Project',
        path: '/project',
        serverId: 'server-1',
        providerId: 'claude',
      },
      { id: 'optimistic-project' }
    );

    expect(result.kind).toBe('creating');
    if (result.kind === 'creating') {
      await expect(result.completion).resolves.toEqual({
        success: false,
        error: { type: 'not-repository', path: '/project' },
      });
    }

    const project = store.projects.get('optimistic-project');
    expect(project && isUnregisteredProject(project)).toBe(true);
    if (project && isUnregisteredProject(project)) {
      expect(project.phase).toBe('error');
      expect(project.error).toBe(
        'Directory is not a git repository. Enable "Initialize git repository" to continue.'
      );
    }
  });
});

export type SearchItemKind = 'session' | 'project' | 'command' | 'file';

export interface SearchItem {
  kind: SearchItemKind;
  id: string;
  projectId: string | null;
  sessionId: string | null;
  title: string;
  subtitle: string;
  score: number;
}

export interface CommandPaletteQuery {
  query: string;
  context?: {
    projectId?: string;
    sessionId?: string;
    workspaceId?: string;
  };
}

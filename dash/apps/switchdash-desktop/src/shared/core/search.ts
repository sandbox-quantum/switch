export type SearchItemKind = 'session' | 'location' | 'command' | 'file';

export interface SearchItem {
  kind: SearchItemKind;
  id: string;
  locationId: string | null;
  sessionId: string | null;
  title: string;
  subtitle: string;
  score: number;
}

export interface CommandPaletteQuery {
  query: string;
  context?: {
    sessionId?: string;
    locationId?: string;
  };
}

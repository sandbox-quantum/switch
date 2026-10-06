export interface FileNode {
  path: string;
  name: string;
  parentPath: string | null;
  depth: number;
  type: 'file' | 'directory';
  children: FileNode[];
  isHidden: boolean;
  extension?: string;
  mtime?: Date;
}

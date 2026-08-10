export interface PluginFs {
  /**
   * Returns the file's content, or `null` only when the file does not exist.
   * Any other failure (transport error, permission denied, …) must throw:
   * callers use read-modify-write, and a failure disguised as "missing file"
   * makes them rewrite the file from scratch, discarding its real content.
   */
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}

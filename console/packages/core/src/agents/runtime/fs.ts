export interface PluginFsWriteOptions {
  /**
   * The file holds a credential: it is readable by its owner alone (`0600`,
   * an owner-only ACL on Windows) inside a directory only its owner can enter
   * (`0700`), including when either already existed with wider permissions.
   * The content is written to a private temporary file and renamed into place,
   * so it is never readable by anyone else, even briefly.
   */
  secret?: boolean;
}

export interface PluginFs {
  /**
   * Returns the file's content, or `null` only when the file does not exist.
   * Any other failure (transport error, permission denied, …) must throw:
   * callers use read-modify-write, and a failure disguised as "missing file"
   * makes them rewrite the file from scratch, discarding its real content.
   */
  read(path: string): Promise<string | null>;
  /**
   * An implementation that cannot honour `secret` must throw rather than
   * write the file with ordinary permissions.
   */
  write(path: string, content: string, options?: PluginFsWriteOptions): Promise<void>;
  /**
   * Gives an existing file the permissions a `secret` write would, without
   * reading or rewriting it, so it cannot undo a concurrent write. Resolves
   * false, changing nothing, when there is no file. An implementation that
   * cannot do this must throw.
   */
  protectSecret(path: string): Promise<boolean>;
  /**
   * Also removes any temporary copy an interrupted `secret` write of the file
   * left beside it. Resolves when the file is already absent; any other
   * failure throws.
   */
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}

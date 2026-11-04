export interface PluginFsWriteOptions {
  /**
   * The file holds a credential. It is readable by its owner alone (`0600`),
   * including when it already existed with wider permissions: the content is
   * written to a private temporary file and renamed into place, so it is never
   * readable by anyone else, even briefly. Its directory is made one only its
   * owner can enter (`0700`) when this account owns it; one owned by another
   * account is left as it is, with a warning, since the file is private either
   * way. On Windows both get owner-only ACLs, and a failure to apply one is a
   * warning rather than an error.
   */
  secret?: boolean;
}

export interface PluginFsProtectOptions {
  /**
   * Leave the file's directory alone: for a credential kept in a directory
   * that belongs to another tool, such as `.claude/`.
   */
  fileOnly?: boolean;
}

export interface PluginFsListOptions {
  /**
   * Throw on any failure other than the directory not being there, rather
   * than answering `[]`, for a caller that must not mistake an unreadable
   * directory for an empty one.
   */
  strict?: boolean;
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
   * An implementation that does not support `secret` must throw rather than
   * write the file with ordinary permissions.
   */
  write(path: string, content: string, options?: PluginFsWriteOptions): Promise<void>;
  /**
   * Gives an existing file the permissions a `secret` write would, without
   * reading or rewriting it, so it cannot undo a concurrent write. Resolves
   * false, changing nothing, when there is no file. An implementation that
   * does not support this must throw.
   */
  protectSecret(path: string, options?: PluginFsProtectOptions): Promise<boolean>;
  /**
   * Also removes any temporary copy an interrupted `secret` write of the file
   * left beside it. Resolves when the file is already absent; any other
   * failure throws.
   */
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string, options?: PluginFsListOptions): Promise<string[]>;
}

import { Loader2 } from 'lucide-react';
import { isUsableRemoteDir, type RemoteDirInspection } from '@shared/core/remote-hosts/remote-dir';

/**
 * Inline notice for a remote working directory that cannot be used
 * (CHOO-1416), alongside `HostReachabilityNotice` in the add-agent modal's
 * run-location field.
 *
 * The directory is free text and was previously only touched at write time, so
 * a wrong path surfaced as a raw `FileSystemError` after an identity had
 * already been minted. Checking it when the user commits the path means they
 * find out while the field is still in front of them.
 *
 * Renders nothing for a directory that exists or that the write will create,
 * so it can be dropped into the form unconditionally.
 */
export function RemoteDirNotice({
  sshHost,
  inspection,
  checking,
  error,
}: {
  sshHost: string;
  inspection: RemoteDirInspection | undefined;
  checking: boolean;
  error: Error | null;
}) {
  if (checking) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-background-1 px-2.5 py-2 text-xs text-foreground-muted">
        <Loader2 className="size-3.5 shrink-0 animate-spin" />
        <span>Checking the working directory on {sshHost}…</span>
      </div>
    );
  }

  // A probe that failed for any reason other than absence (permission denied, a
  // dropped connection) is not evidence the directory is missing, and is
  // reported as itself so the user does not go and fix the wrong thing.
  if (error) {
    return (
      <NoticeShell>
        Couldn’t check the working directory on {sshHost} — {error.message}
      </NoticeShell>
    );
  }

  if (!inspection || isUsableRemoteDir(inspection)) return null;

  return (
    <NoticeShell>
      {inspection.status === 'file' ? (
        <>
          <span className="font-mono break-all">{inspection.dir}</span> is a file, not a directory.
        </>
      ) : (
        <>
          <span className="font-mono break-all">{inspection.dir}</span> does not exist on {sshHost}.
          Create it there first.
        </>
      )}
    </NoticeShell>
  );
}

function NoticeShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-2 text-xs break-words text-foreground">
      {children}
    </div>
  );
}

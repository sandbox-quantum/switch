import { ExternalLink, GitBranch, GitPullRequest, Info, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@renderer/lib/ui/alert';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';

export function ManagedGitHubStep({ onBack, onSkip }: { onBack: () => void; onSkip: () => void }) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect GitHub</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="space-y-5 pt-0">
        <p className="text-sm text-foreground-muted">
          Give your cloud agents access to the repositories you choose.
        </p>
        <div className="space-y-4 rounded-lg border p-4">
          <div className="flex gap-3">
            <GitBranch className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Choose your repositories</h3>
              <p className="text-xs text-foreground-muted">
                Install the Switch GitHub App on your account or organization. Select which
                repositories it can access on GitHub.
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <GitPullRequest className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Let agents work on your code</h3>
              <p className="text-xs text-foreground-muted">
                Repository contents and pull request access will let agents clone code, push
                branches, and open pull requests. Review the permissions on GitHub before approving.
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-foreground-muted" />
            <div className="space-y-1">
              <h3 className="text-sm font-medium">Stay in control</h3>
              <p className="text-xs text-foreground-muted">
                No personal token to copy. Change repository access or uninstall the app from GitHub
                at any time. Your organization may require an owner’s approval.
              </p>
            </div>
          </div>
        </div>
        <Alert>
          <Info />
          <AlertTitle>Preview</AlertTitle>
          <AlertDescription>
            GitHub connection is not available yet. You can set it up later; your Claude connection
            is already saved.
          </AlertDescription>
        </Alert>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          Set up later
        </Button>
        <Button disabled>
          Connect GitHub <ExternalLink className="size-4" />
        </Button>
      </DialogFooter>
    </>
  );
}

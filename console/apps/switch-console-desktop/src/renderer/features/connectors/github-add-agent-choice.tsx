import { Button } from '@renderer/lib/ui/button';
import {
  type ConnectedGitHub,
  type GitHubGrantChoice,
  NOTHING_CHOSEN_NOTE,
  githubChoiceSummary,
} from './github-grant';
import { GitHubGrantPicker } from './github-grant-picker';

/**
 * What every agent added from GitHub's page gets, above the agent search: a
 * warning while nothing is chosen, the choice in a sentence once it is, and
 * a button that opens the picker in place and closes it again.
 */
export function GitHubAddAgentChoice({
  github,
  choice,
  onChange,
  choosing,
  onChoosingChange,
}: {
  github: ConnectedGitHub;
  choice: GitHubGrantChoice;
  onChange: (choice: GitHubGrantChoice) => void;
  choosing: boolean;
  onChoosingChange: (choosing: boolean) => void;
}) {
  const summary = githubChoiceSummary(github, choice);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        {summary === null ? (
          <p role="status" className="flex-1 text-sm text-foreground-warning">
            {NOTHING_CHOSEN_NOTE}
          </p>
        ) : (
          <p className="flex-1 text-sm text-foreground-muted">
            Agents you add get {summary}. Each can be changed later on its Connections tab.
          </p>
        )}
        <Button
          variant="outline"
          size="sm"
          aria-expanded={choosing}
          onClick={() => onChoosingChange(!choosing)}
        >
          {choosing ? 'Done' : summary === null ? 'Choose repositories' : 'Change'}
        </Button>
      </div>
      {choosing && (
        <div className="rounded-lg border border-border p-3">
          <GitHubGrantPicker github={github} value={choice} onChange={onChange} />
        </div>
      )}
    </div>
  );
}

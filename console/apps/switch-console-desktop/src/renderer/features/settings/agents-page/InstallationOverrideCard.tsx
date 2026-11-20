import { Loader2 } from 'lucide-react';
import { useState } from 'react';
import { failureText } from '@renderer/lib/errors/describe-failure';
import type { HostDependencyInstallation } from '@renderer/lib/stores/use-agent-installation-statuses';
import { Alert } from '@renderer/lib/ui/alert';
import { Input } from '@renderer/lib/ui/input';
import type { Installation } from '@shared/core/providers/agent-payload';
import { CommandActionButton } from './install-command-row';
import { overrideProblem } from './installation-sources';

export type InstallationOverrideCardProps = {
  vm: HostDependencyInstallation;
  kind: 'path' | 'cli';
  /** Initial value from persisted selection, if any. */
  initialValue?: string;
  /** Called when checking state changes (for parent to derive 'checking' state). */
  onChecking: (isChecking: boolean) => void;
  /** Called with the probe result once Validate completes (null means probeOverride returned nothing). */
  onResolved: (installation: Installation | null) => void;
};

export function InstallationOverrideCard({
  vm,
  kind,
  initialValue = '',
  onChecking,
  onResolved,
}: InstallationOverrideCardProps) {
  const [value, setValue] = useState(initialValue);
  const [isChecking, setIsChecking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const handleValidate = async () => {
    setIsChecking(true);
    setProblem(null);
    onChecking(true);
    try {
      const selection = kind === 'path' ? { path: value } : { cli: value };
      const result = await vm.probeOverride(selection);
      setProblem(overrideProblem(kind, value, result ?? null));
      onResolved(result ?? null);
    } catch (error) {
      setProblem(failureText(error, `Could not check ${value.trim()}.`));
    } finally {
      setIsChecking(false);
      onChecking(false);
    }
  };

  const hasValue = value.trim().length > 0;

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <Input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setProblem(null);
        }}
        placeholder={
          kind === 'path' ? '/usr/local/bin/claude' : kind === 'cli' ? 'claude' : undefined
        }
        className="font-mono text-sm"
        disabled={isChecking}
      />
      {problem && <Alert variant="destructive">{problem}</Alert>}
      <Alert variant="warning">
        {kind === 'path'
          ? "Using an absolute path to the agent binary overrides auto-resolution and disables Switch Console's ability to update the agent."
          : "Enter the command name or binary resolved on PATH. This overrides auto-resolution and disables Switch Console's ability to update the agent."}
      </Alert>
      {hasValue && (
        <div className="flex justify-end">
          <CommandActionButton disabled={isChecking} onClick={() => void handleValidate()}>
            {isChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Validate'}
          </CommandActionButton>
        </div>
      )}
    </div>
  );
}

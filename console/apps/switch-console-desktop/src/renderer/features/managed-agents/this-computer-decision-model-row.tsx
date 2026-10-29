import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingRow } from '@renderer/features/settings/components/SettingRow';
import { failureText } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Switch } from '@renderer/lib/ui/switch';

export const THIS_COMPUTER_DECISION_MODEL_KEY = ['this-computer-decision-model'];

/**
 * "Let this computer run the decision model": whether a workspace admin may
 * run auto-route's decision model on this computer. Off, its controller
 * refuses, and Decision routing shows this computer as turned off on the
 * machine. Kept between launches; changing it restarts this computer's
 * controllers, which leaves their agents running.
 */
export function ThisComputerDecisionModelRow() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: THIS_COMPUTER_DECISION_MODEL_KEY,
    queryFn: () => rpc.embeddedController.getDecisionModelEnabled(),
  });
  const change = useMutation({
    mutationFn: (enabled: boolean) => rpc.embeddedController.setDecisionModelEnabled(enabled),
    onSettled: () => queryClient.invalidateQueries({ queryKey: THIS_COMPUTER_DECISION_MODEL_KEY }),
  });
  const enabled = change.isPending ? change.variables : query.data;
  const problem = query.error ?? change.error;
  return (
    <SettingRow
      title="Let this computer run the decision model"
      description={
        <>
          A workspace admin can choose this computer to decide which agent answers untagged messages
          (Admin → Decision routing). It downloads a small model once and runs it only while chosen.
          Turned off, it stops the model if it runs and refuses to start it.
          {problem && (
            <span className="mt-1 block text-foreground-error">
              {failureText(problem, 'Could not change whether this computer runs it.')}
            </span>
          )}
        </>
      }
      control={
        <Switch
          aria-label="Let this computer run the decision model"
          checked={enabled ?? true}
          disabled={enabled === undefined || change.isPending}
          onCheckedChange={(checked) => change.mutate(checked)}
        />
      }
    />
  );
}

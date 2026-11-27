import { type ReactNode } from 'react';
import { Button } from '../primitives/button';
import { Input } from '../primitives/input';
import { Switch } from '../primitives/switch';
import { SettingRow } from './setting-row';

export type AgentMachineRowsProps = {
  machineName: string | null;
  thisComputer: boolean;
  directory: string;
  isolation: 'shared' | 'isolated' | null;
  cloud: boolean;
  onDirectoryChange?: (value: string) => void;
  onIsolationChange?: (value: 'shared' | 'isolated') => void;
  onChangeDevice?: () => void;
  directorySelector?: ReactNode;
};

/**
 * Device, directory, and isolation rows for a managed agent's settings.
 * When editing, provide onChange handlers; in read-only mode, omit them.
 */
export function AgentMachineRows({
  machineName,
  thisComputer,
  directory,
  isolation,
  cloud,
  onDirectoryChange,
  onIsolationChange,
  onChangeDevice,
  directorySelector,
  machineWord,
}: AgentMachineRowsProps & { machineWord: 'machine' | 'device' }) {
  const deviceName = machineName ?? 'no device';
  const deviceLabel = thisComputer ? `${machineName} (this computer)` : deviceName;

  return (
    <>
      <SettingRow
        title="Device"
        info={null}
        description={machineName ? `Runs on ${deviceLabel}.` : 'Runs on no device.'}
        control={
          onChangeDevice ? (
            <Button variant="outline" size="sm" onClick={onChangeDevice}>
              Change…
            </Button>
          ) : null
        }
      />
      <SettingRow
        title="Directory"
        info={{
          label: 'More info about the directory',
          content:
            `The working directory, a full path on its ${machineWord}. Its sessions start there. ` +
            'Changing it applies to new sessions only: a room where the agent already has a ' +
            'session keeps the directory that session started in, through a reset too, until ' +
            'the session is recreated.',
        }}
        description={`Where the agent runs on ${machineName ?? `its ${machineWord}`}.`}
        control={null}
      >
        {directorySelector ? (
          directorySelector
        ) : onDirectoryChange ? (
          <Input
            value={directory}
            onChange={(e) => onDirectoryChange(e.target.value)}
            placeholder="Where the agent runs"
            aria-label="Directory"
            className="font-mono text-sm"
          />
        ) : (
          <p className="font-mono text-sm text-foreground-muted">{directory || '—'}</p>
        )}
      </SettingRow>
      {cloud ? (
        <SettingRow
          title="Runs in its own process"
          info={null}
          description={`Switch Cloud runs every agent as a user of its own, apart from the other agents and the ${machineWord}'s controller.`}
          control={null}
        />
      ) : (
        <SettingRow
          title="Run in its own process"
          info={{
            label: 'More info about running in its own process',
            content: `Isolated from the other agents on its ${machineWord}, instead of inside the ${machineWord}'s controller.`,
          }}
          description={`Keep it apart from the other agents on its ${machineWord}.`}
          control={
            onIsolationChange ? (
              <Switch
                aria-label="Run in its own process"
                checked={isolation === 'isolated'}
                onCheckedChange={(checked) => onIsolationChange(checked ? 'isolated' : 'shared')}
              />
            ) : null
          }
        />
      )}
    </>
  );
}

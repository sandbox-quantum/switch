import { useEffect, useState } from 'react';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';

/**
 * Whether this build can connect to Switch Cloud.
 *
 * Four states, not two. Not configured is the ordinary answer for a build that
 * was never pointed at a deployment. A configuration that could not be read is
 * a broken build or launch, and reporting it as "not open yet" would hide the
 * one thing that needs fixing.
 */
export type SwitchCloudAvailability =
  | { kind: 'reading' }
  | { kind: 'closed' }
  | { kind: 'open'; url: string }
  | { kind: 'failed'; headline: string; detail: string | null };

export function useSwitchCloud(): SwitchCloudAvailability {
  const [cloud, setCloud] = useState<SwitchCloudAvailability>({ kind: 'reading' });
  useEffect(() => {
    let current = true;
    void rpc.switchServers.switchCloud().then(
      (endpoint) => {
        if (current) setCloud(endpoint ? { kind: 'open', url: endpoint.url } : { kind: 'closed' });
      },
      (cause) => {
        if (current) {
          setCloud({
            kind: 'failed',
            ...describeFailure(cause, 'Could not read the Switch Cloud configuration.'),
          });
        }
      }
    );
    return () => {
      current = false;
    };
  }, []);
  return cloud;
}

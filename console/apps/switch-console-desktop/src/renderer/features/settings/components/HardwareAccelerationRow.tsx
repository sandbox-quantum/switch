import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import React from 'react';
import { toast } from 'sonner';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Switch } from '@renderer/lib/ui/switch';
import { SettingRow } from './SettingRow';

const QUERY_KEY = ['app', 'hardwareAcceleration'];

/**
 * Whether Console draws with the GPU. Read once at launch, so a change applies
 * after a restart. Console turns it off by itself when the GPU cannot draw its
 * window, and says so here.
 */
export const HardwareAccelerationRow: React.FC = () => {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => rpc.app.getHardwareAcceleration(),
  });
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const result = await rpc.app.setHardwareAcceleration(enabled);
      if (!result.success) throw new Error(result.error);
    },
    onError: (cause) => {
      const { headline, detail } = describeFailure(
        cause,
        'Could not save the hardware acceleration setting.'
      );
      toast.error(headline, detail ? { description: detail } : undefined);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const restartNeeded = data?.restartNeeded ?? false;

  return (
    <SettingRow
      title="Hardware acceleration"
      description={
        <>
          Draw the window with the GPU. Turn it off if the window stays blank or flickers.
          {data?.disabledAutomatically && (
            <>
              {' '}
              Turned off automatically on {new Date(
                data.disabledAutomatically.at
              ).toLocaleString()}{' '}
              because {data.disabledAutomatically.detail}.
            </>
          )}
          {restartNeeded && <> Takes effect after a restart.</>}
        </>
      }
      control={
        <>
          {restartNeeded && (
            <Button variant="outline" size="sm" onClick={() => void rpc.app.restart()}>
              Restart
            </Button>
          )}
          <Switch
            checked={data?.enabled ?? true}
            disabled={data === undefined || mutation.isPending}
            onCheckedChange={(checked) => mutation.mutate(checked)}
          />
        </>
      }
    />
  );
};

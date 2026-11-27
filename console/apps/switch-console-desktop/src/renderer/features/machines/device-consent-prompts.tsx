import { useQueryClient } from '@tanstack/react-query';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { events, rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { modalStore } from '@renderer/lib/modal/modal-store';
import type {
  DeviceConsentAsk,
  DeviceConsentEvent,
} from '@shared/core/embedded-controller/embedded-controller';
import { embeddedControllerConsentChannel } from '@shared/events/embeddedControllerEvents';

/** Query key for what agents ask of this computer, across servers. */
export const DEVICE_CONSENT_KEY = ['device-consent'] as const;

/** One ask as the prompts tell it from another: the same agent asking the same again is the same. */
export function askKey(serverId: string, ask: DeviceConsentAsk): string {
  return [serverId, ask.agentId, ask.bypass ? 'bypass' : '', ask.directory ?? ''].join('\u0000');
}

/**
 * Puts what a managed agent asks of this computer to the person, once per ask
 * in a session: a modal, as soon as no other is open. One closed without an
 * answer is not put again until Console restarts; this computer's page under
 * Machines still lists it.
 */
export const DeviceConsentPrompts = observer(function DeviceConsentPrompts() {
  const queryClient = useQueryClient();
  const [asks, setAsks] = useState<Map<string, DeviceConsentAsk[]>>(new Map());
  const [shown] = useState(() => new Set<string>());

  useEffect(() => {
    let live = true;
    const take = (event: DeviceConsentEvent) =>
      setAsks((current) => new Map(current).set(event.serverId, event.asks));
    const off = events.on(embeddedControllerConsentChannel, (event) => {
      take(event);
      void queryClient.invalidateQueries({ queryKey: DEVICE_CONSENT_KEY });
    });
    void rpc.embeddedController.consentAsks().then((current) => {
      if (live) for (const event of current) take(event);
    });
    return () => {
      live = false;
      off();
    };
  }, [queryClient]);

  const busy = modalStore.isOpen;
  useEffect(() => {
    if (busy) return;
    for (const [serverId, list] of asks)
      for (const ask of list) {
        const key = askKey(serverId, ask);
        if (shown.has(key)) continue;
        shown.add(key);
        showModal('deviceConsentModal', {
          serverId,
          ask,
          onSuccess: () => void queryClient.invalidateQueries({ queryKey: DEVICE_CONSENT_KEY }),
        });
        return;
      }
  }, [asks, busy, shown, queryClient]);

  return null;
});

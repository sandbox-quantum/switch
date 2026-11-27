type EventIpc = {
  send: (channel: string, data: unknown) => void;
  on: (channel: string, listener: (event: unknown, data: unknown) => void) => void;
  removeListener: (channel: string, listener: (event: unknown, data: unknown) => void) => void;
};

/**
 * The renderer's `eventSend` and `eventOn`, held to the channels of the events
 * the app defines (`isAppEventChannel`). Any other channel is refused before it
 * reaches `ipcRenderer`, so the renderer can neither send to an `ipcMain.on`
 * listener that is not an app event nor listen on a channel that is not one.
 */
export function createEventBridge(ipc: EventIpc, isAllowed: (channel: string) => boolean) {
  const check = (channel: string) => {
    if (typeof channel !== 'string' || !isAllowed(channel))
      throw new Error(`"${String(channel)}" is not an event channel this app defines.`);
  };
  return {
    eventSend: (channel: string, data: unknown) => {
      check(channel);
      ipc.send(channel, data);
    },
    eventOn: (channel: string, cb: (data: unknown) => void) => {
      check(channel);
      const wrapped = (_: unknown, data: unknown) => cb(data);
      ipc.on(channel, wrapped);
      return () => ipc.removeListener(channel, wrapped);
    },
  };
}

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { isAppEventChannel } from '@shared/lib/ipc/event-channels';
import { createEventBridge } from './event-bridge';
import { createRpcInvoke } from './rpc-invoke';

// Expose protected methods that allow the renderer process to use
contextBridge.exposeInMainWorld('electronAPI', {
  // Generic invoke for the typed RPC client (createRPCClient)
  invoke: createRpcInvoke((channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  // Generic event bridge for the typesafe event emitter (createEventEmitter)
  ...createEventBridge(ipcRenderer, isAppEventChannel),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});

import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  /** Get the app version */
  getVersion: (): Promise<string> => ipcRenderer.invoke('get-version'),

  /** Real path of a file dropped or pasted from disk ('' for one made in the page) */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  /** Invoke a command on the main process (mirrors Tauri invoke) */
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),

  /** Listen for events from the main process (mirrors Tauri listen) */
  on: (channel: string, callback: (...args: unknown[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});

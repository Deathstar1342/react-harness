// Sandboxed preload: only Electron's limited require shim, no Node/filesystem.
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './contracts.js';
const bridge:DesktopBridge={
  status:()=>ipcRenderer.invoke('desktop:status'),
  start:input=>ipcRenderer.invoke('desktop:start',input),
  pickDirectory:()=>ipcRenderer.invoke('desktop:pick'),
  helper:action=>ipcRenderer.invoke('desktop:helper',action),
  dirty:value=>ipcRenderer.invoke('desktop:dirty',value),
};
contextBridge.exposeInMainWorld('abyssusDesktop',Object.freeze(bridge));

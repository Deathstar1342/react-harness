// Sandboxed preload: only Electron's limited require shim, no Node/filesystem.
import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './contracts.js';
let editorDirty=false,freeze:string|undefined;
ipcRenderer.on('desktop:freeze',(_event,nonce:string)=>{
  freeze=nonce;document.documentElement.inert=true;
  ipcRenderer.send('desktop:frozen',{nonce,dirty:editorDirty});
});
ipcRenderer.on('desktop:thaw',(_event,nonce:string)=>{if(freeze===nonce){freeze=undefined;document.documentElement.inert=false;}});
const bridge:DesktopBridge={
  status:()=>ipcRenderer.invoke('desktop:status'),
  checkContainer:()=>ipcRenderer.invoke('desktop:container-check'),
  pickStorage:()=>ipcRenderer.invoke('desktop:storage-pick'),
  startContainer:input=>ipcRenderer.invoke('desktop:container-start',input),
  restartContainer:()=>ipcRenderer.invoke('desktop:container-restart'),
  authorizeTransfer:input=>ipcRenderer.invoke('desktop:transfer',input),
  start:input=>ipcRenderer.invoke('desktop:start',input),
  pickDirectory:()=>ipcRenderer.invoke('desktop:pick'),
  helper:action=>ipcRenderer.invoke('desktop:helper',action),
  dirty:value=>{editorDirty=value;return ipcRenderer.invoke('desktop:dirty',value);},
};
contextBridge.exposeInMainWorld('abyssusDesktop',Object.freeze(bridge));

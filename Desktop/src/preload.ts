/**
 * 桌面端 preload：只向页面暴露书斋所需的最少能力（查看状态、经系统对话框选文件夹、重开最近的书斋、收起、在资源管理器中显示）。
 * 不暴露 Node、文件读写或任意路径；Agent 的读写走后端 → 主进程，不经过页面。
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type Listener = (state: unknown) => void;

contextBridge.exposeInMainWorld('gorDesktop', {
  shuzhai: {
    getState: () => ipcRenderer.invoke('gor:shuzhai:get-state'),
    pickFolder: () => ipcRenderer.invoke('gor:shuzhai:pick-folder'),
    openRecent: (folderPath: string) => ipcRenderer.invoke('gor:shuzhai:open-recent', String(folderPath)),
    close: () => ipcRenderer.invoke('gor:shuzhai:close'),
    reveal: () => ipcRenderer.invoke('gor:shuzhai:reveal'),
    onState: (listener: Listener) => {
      if (typeof listener !== 'function') return () => undefined;
      const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
      ipcRenderer.on('gor:shuzhai:state', handler);
      return () => { ipcRenderer.removeListener('gor:shuzhai:state', handler); };
    },
  },
});

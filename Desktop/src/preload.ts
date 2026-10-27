/**
 * 桌面端 preload：只向页面暴露书斋所需的最少能力（查看状态、经系统对话框选文件夹或新建项目、重开最近的书斋、
 * 打开拖入窗口的文件夹、收起、在资源管理器中显示）与施行卡片的消息通道。
 * 不暴露 Node、文件读写或任意路径：拖入的文件夹路径在这里从文件对象取得，页面不能直接传路径。
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

type Listener = (value: unknown) => void;

function subscribe(channel: string, listener: Listener): () => void {
  if (typeof listener !== 'function') return () => undefined;
  const handler = (_event: IpcRendererEvent, value: unknown) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

contextBridge.exposeInMainWorld('gorDesktop', {
  shuzhai: {
    getState: () => ipcRenderer.invoke('gor:shuzhai:get-state'),
    pickFolder: () => ipcRenderer.invoke('gor:shuzhai:pick-folder'),
    createProject: () => ipcRenderer.invoke('gor:shuzhai:create-project'),
    openRecent: (folderPath: string) => ipcRenderer.invoke('gor:shuzhai:open-recent', String(folderPath)),
    openDropped: (file: File) => {
      let folderPath = '';
      try { folderPath = webUtils.getPathForFile(file); } catch { /* 不是用户拖入的文件对象 */ }
      return ipcRenderer.invoke('gor:shuzhai:open-dropped', folderPath);
    },
    close: () => ipcRenderer.invoke('gor:shuzhai:close'),
    reveal: () => ipcRenderer.invoke('gor:shuzhai:reveal'),
    // 遥斋：允许网页遥控此书斋的开关，与断开某台正在遥控的设备
    setRemoteAllowed: (allowed: boolean) => ipcRenderer.invoke('gor:shuzhai:set-remote-allowed', allowed === true),
    disconnectRemote: (clientId: string) => ipcRenderer.invoke('gor:shuzhai:disconnect-remote', String(clientId)),
    onState: (listener: Listener) => subscribe('gor:shuzhai:state', listener),
    toolchain: {
      send: (message: unknown) => ipcRenderer.invoke('gor:shuzhai:toolchain', message),
      onMessage: (listener: Listener) => subscribe('gor:shuzhai:toolchain', listener),
    },
  },
});

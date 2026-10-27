import { useCallback, useEffect, useState } from 'react';
import {
  getDesktopMode, isDesktopApp, shuzhai, switchDesktopMode, useShuzhaiState,
  type DesktopMode, type ShuzhaiOpenResult,
} from './desktopRuntime';

/** 桌面端书斋的宿主逻辑（状态、忙碌、失败原因与操作），供聊天页接入纯展示的切换器与空状态。 */
export function useShuzhaiControls(notify: (message: string) => void) {
  const state = useShuzhaiState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const enabled = isDesktopApp();
  const mode = getDesktopMode() ?? 'yunjian';

  const open = useCallback(async (action: () => Promise<ShuzhaiOpenResult | undefined> | undefined) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (result && !result.ok && result.reason && result.reason !== 'cancelled') {
        setError(result.reason);
        notify(result.reason);
      }
    } catch {
      setError('书斋操作失败，请重试。');
      notify('书斋操作失败，请重试。');
    } finally {
      setBusy(false);
    }
  }, [notify]);

  // 书斋模式：把文件夹拖进窗口即设为书斋。只拦截文件夹，拖入的普通文件仍交给原有的附件处理。
  useEffect(() => {
    if (!enabled || mode !== 'shuzhai') return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const folderOf = (event: DragEvent): File | undefined => {
      const items = Array.from(event.dataTransfer?.items ?? []);
      const index = items.findIndex((item) => item.kind === 'file' && item.webkitGetAsEntry?.()?.isDirectory);
      return index >= 0 ? items[index].getAsFile() ?? undefined : undefined;
    };
    const enter = (event: DragEvent) => { if (hasFiles(event)) { depth += 1; setDragActive(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragActive(false); };
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault(); };
    const drop = (event: DragEvent) => {
      depth = 0;
      setDragActive(false);
      const folder = folderOf(event);
      if (!folder) return;
      event.preventDefault();
      event.stopPropagation();
      void open(() => shuzhai.openDropped(folder));
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop, true);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop, true);
    };
  }, [enabled, mode, open]);

  return {
    enabled,
    mode,
    state,
    busy,
    error,
    dragActive,
    createProject: useCallback(() => { void open(() => shuzhai.createProject()); }, [open]),
    switchMode: useCallback((mode: DesktopMode) => switchDesktopMode(mode), []),
    pickFolder: useCallback(() => { void open(() => shuzhai.pickFolder()); }, [open]),
    openRecent: useCallback((folderPath: string) => { void open(() => shuzhai.openRecent(folderPath)); }, [open]),
    reveal: useCallback(() => { void shuzhai.reveal(); }, []),
    closeFolder: useCallback(() => {
      setBusy(true);
      void Promise.resolve(shuzhai.close()).finally(() => setBusy(false));
    }, []),
  };
}

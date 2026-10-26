import { useCallback, useState } from 'react';
import {
  getDesktopMode, isDesktopApp, shuzhai, switchDesktopMode, useShuzhaiState,
  type DesktopMode, type ShuzhaiOpenResult,
} from './desktopRuntime';

/** 桌面端书斋的宿主逻辑（状态、忙碌、失败原因与操作），供聊天页接入纯展示的切换器与空状态。 */
export function useShuzhaiControls(notify: (message: string) => void) {
  const state = useShuzhaiState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return {
    enabled: isDesktopApp(),
    mode: getDesktopMode() ?? 'yunjian',
    state,
    busy,
    error,
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

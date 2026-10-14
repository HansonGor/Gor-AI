import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileEditMode } from '../components/chat/FileEditModeSelector';

export type ExecutionEditMode = 'auto' | 'review';
async function preference(sessionId: string, mode?: ExecutionEditMode): Promise<ExecutionEditMode> {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/edit-mode`, {
    method: mode ? 'PUT' : 'GET',
    cache: 'no-store',
    ...(mode ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ editMode: mode }) } : {}),
  });
  if (!response.ok) throw new Error('文件变更请求失败。');
  const data = await response.json();
  if (data.editMode !== 'auto' && data.editMode !== 'review') throw new Error('文件变更请求失败。');
  return data.editMode;
}

/** Session preference only. Every send captures an immutable mode promise. */
export function useFileEditMode(sessionId: string | null, onError?: (message: string) => void) {
  const [selection, setSelection] = useState<{ id: string; mode: FileEditMode } | null>(null);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const state = useRef<{ id: string; ready: Promise<ExecutionEditMode> } | null>(null);
  const errorCallback = useRef(onError);
  errorCallback.current = onError;
  useEffect(() => {
    if (!sessionId) { state.current = null; return; }
    const current = { id: sessionId, ready: preference(sessionId) };
    state.current = current;
    setLoadingSession(sessionId);
    current.ready = current.ready.then(mode => {
      if (state.current === current) setSelection({ id: sessionId, mode: mode === 'auto' ? 'instant' : 'review' });
      return mode;
    });
    void current.ready.catch(() => {
      if (state.current === current) errorCallback.current?.('文件变更请求失败。');
      // Keep the rejection for sends; never silently fall back to auto.
    });
    const read = current.ready;
    const settled = () => {
      if (state.current === current && current.ready === read) setLoadingSession(null);
    };
    void read.then(settled, settled);
    return () => { if (state.current === current) state.current = null; };
  }, [sessionId]);
  const setFileEditMode = useCallback((mode: FileEditMode) => {
    if (!sessionId || state.current?.id !== sessionId) return;
    const current = state.current;
    setLoadingSession(sessionId);
    const execution: ExecutionEditMode = mode === 'instant' ? 'auto' : 'review';
    // Serialize against this session's initial read and earlier saves. Only a
    // server-confirmed preference changes the displayed selection.
    const operation = current.ready.catch(() => undefined).then(() => preference(sessionId, execution)).then(saved => {
      if (state.current === current) setSelection({ id: sessionId, mode: saved === 'auto' ? 'instant' : 'review' });
      return saved;
    });
    current.ready = operation;
    const settled = () => {
      if (state.current === current && current.ready === operation) setLoadingSession(null);
    };
    void operation.then(settled, settled);
    void operation.catch(() => {
      if (state.current === current) errorCallback.current?.('文件变更请求失败。');
    });
  }, [sessionId]);
  const freezeFileEditMode = useCallback(() => {
    if (!sessionId || state.current?.id !== sessionId) return Promise.reject(new Error('文件变更请求失败。'));
    return state.current.ready;
  }, [sessionId]);
  return { fileEditMode: selection?.id === sessionId ? selection.mode : 'instant' as FileEditMode,
    fileEditModeLoading: !!sessionId && loadingSession === sessionId,
    setFileEditMode, freezeFileEditMode };
}

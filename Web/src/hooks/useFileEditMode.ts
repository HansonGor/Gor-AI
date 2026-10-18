import { useCallback } from 'react';
import type { FileEditMode } from '../components/chat/FileEditModeSelector';
import { useSessionPreference } from './useSessionPreference';

export type ExecutionEditMode = 'auto' | 'review';
const EXECUTION_MODES = ['auto', 'review'] as const;

/** Shared global database preference; every send captures an immutable mode promise. */
export function useFileEditMode(sessionId: string | null, onError?: (message: string) => void) {
  const preference = useSessionPreference<ExecutionEditMode>(sessionId, {
    path: 'edit-mode', field: 'editMode', values: EXECUTION_MODES, errorMessage: '文件变更请求失败。', onError,
  });
  const { setValue } = preference;
  const setFileEditMode = useCallback((mode: FileEditMode) => {
    setValue(mode === 'instant' ? 'auto' : 'review');
  }, [setValue]);
  return {
    fileEditMode: (preference.value === 'review' ? 'review' : 'instant') as FileEditMode,
    fileEditModeLoading: preference.loading,
    setFileEditMode,
    // Keep the rejection for sends; never silently fall back to auto.
    freezeFileEditMode: preference.freeze,
  };
}

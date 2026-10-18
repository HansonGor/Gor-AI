import { useCallback } from 'react';
import { useSessionPreference } from './useSessionPreference';

/** auto = 酌思（默认，按问题自动选深浅）；light = 随思（关闭模型深度思考）；deep = 深思（开启模型深度思考）。 */
export type ThinkingMode = 'auto' | 'light' | 'deep';
export const DEFAULT_THINKING_MODE: ThinkingMode = 'auto';
const THINKING_MODES = ['auto', 'light', 'deep'] as const;

/** 全局共享思考方式，默认酌思。读取失败时按酌思发送，不阻止用户发送消息。 */
export function useThinkingMode(sessionId: string | null, onError?: (message: string) => void) {
  const preference = useSessionPreference<ThinkingMode>(sessionId, {
    path: 'thinking-mode', field: 'thinkingMode', values: THINKING_MODES, errorMessage: '思考方式保存失败。', onError,
  });
  const { freeze } = preference;
  const freezeThinkingMode = useCallback(
    (): Promise<ThinkingMode> => freeze().catch(() => DEFAULT_THINKING_MODE), [freeze]);
  return {
    thinkingMode: preference.value ?? DEFAULT_THINKING_MODE,
    thinkingModeLoading: preference.loading,
    setThinkingMode: preference.setValue,
    freezeThinkingMode,
  };
}

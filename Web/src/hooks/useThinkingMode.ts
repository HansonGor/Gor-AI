import { useCallback } from 'react';
import { useSessionPreference } from './useSessionPreference';

/** deep = 深思（开启模型深度思考，默认）；light = 随思（关闭模型深度思考）。 */
export type ThinkingMode = 'light' | 'deep';
const THINKING_MODES = ['light', 'deep'] as const;

/** 会话级思考方式，默认深思。与落笔方式不同：读取失败时按深思发送，不阻止用户发送消息。 */
export function useThinkingMode(sessionId: string | null, onError?: (message: string) => void) {
  const preference = useSessionPreference<ThinkingMode>(sessionId, {
    path: 'thinking-mode', field: 'thinkingMode', values: THINKING_MODES, errorMessage: '思考方式保存失败。', onError,
  });
  const { freeze } = preference;
  const freezeThinkingMode = useCallback(
    (): Promise<ThinkingMode> => freeze().catch(() => 'deep' as ThinkingMode), [freeze]);
  return {
    thinkingMode: preference.value ?? 'deep',
    thinkingModeLoading: preference.loading,
    setThinkingMode: preference.setValue,
    freezeThinkingMode,
  };
}

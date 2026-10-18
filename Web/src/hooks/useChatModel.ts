import { useCallback } from 'react';
import { useSessionPreference } from './useSessionPreference';

const isModelId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

export function applyChatModelSelection(
  modelId: string,
  currentModelId: string | null | undefined,
  setModel: (value: string) => void,
  setThinkingMode: (value: 'auto') => void,
) {
  // 换模型时思考方式回到默认的酌思
  if (modelId !== currentModelId) setThinkingMode('auto');
  setModel(modelId);
}

/**
 * 当前页面内的临时模型选择；服务端只接收选择并冻结本轮，不持久化。
 * 页面重载或切换会话后回到服务端默认模型。
 */
export function useChatModel(sessionId: string | null, onError?: (message: string) => void) {
  const preference = useSessionPreference<string>(sessionId, {
    path: 'model', field: 'modelId', values: isModelId, errorMessage: '模型选择保存失败。', onError,
  });
  const { freeze } = preference;
  const freezeChatModel = useCallback(
    (): Promise<string | undefined> => freeze().catch(() => undefined), [freeze]);
  return {
    chatModelId: preference.value,
    chatModelLoading: preference.loading,
    setChatModel: preference.setValue,
    freezeChatModel,
  };
}

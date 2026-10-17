import { useCallback } from 'react';
import { useSessionPreference } from './useSessionPreference';

const isModelId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 200;

/**
 * 会话级模型选择，与落笔方式、思考方式同一套保存机制。
 * 读取失败时发送不带 modelId，由服务端按会话偏好或默认模型处理，不阻止发送。
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

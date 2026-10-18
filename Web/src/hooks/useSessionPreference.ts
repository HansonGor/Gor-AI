import { useCallback, useEffect, useRef, useState } from 'react';

export type SessionPreferenceOptions<T extends string> = {
  /** 例如 `edit-mode` → `/api/chat/session/{id}/edit-mode` */
  path: string;
  /** 请求与响应 JSON 中的字段名，例如 `editMode` */
  field: string;
  /** 固定可选值，或校验函数（可选值来自服务端列表时使用） */
  values: readonly T[] | ((value: unknown) => value is T);
  errorMessage: string;
  onError?: (message: string) => void;
};

async function request<T extends string>(sessionId: string, options: SessionPreferenceOptions<T>, value?: T): Promise<T> {
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/${options.path}`, {
    method: value ? 'PUT' : 'GET',
    cache: 'no-store',
    ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [options.field]: value }) } : {}),
  });
  if (!response.ok) throw new Error(options.errorMessage);
  const data = await response.json();
  const saved = data?.[options.field];
  const valid = typeof options.values === 'function' ? options.values(saved) : options.values.includes(saved);
  if (!valid) throw new Error(options.errorMessage);
  return saved as T;
}

/**
 * 通过兼容的会话作用域 API 读取服务端偏好（Web 与 VS Code 共用，不做本地缓存）。
 * 落笔/思考模式由服务端全局持久化；模型选择仅在当前页面运行期间有效。
 * 显示值只在服务端确认后变化；保存与首次读取串行；切换会话后迟到的结果不会改写当前会话。
 * freeze() 在发送时调用，返回该时刻的偏好 Promise；失败时如何处理由调用方决定。
 */
export function useSessionPreference<T extends string>(sessionId: string | null, options: SessionPreferenceOptions<T>) {
  const [selection, setSelection] = useState<{ id: string; value: T } | null>(null);
  const [loadingSession, setLoadingSession] = useState<string | null>(null);
  const state = useRef<{ id: string; ready: Promise<T> } | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!sessionId) { state.current = null; return; }
    const current = { id: sessionId, ready: request(sessionId, optionsRef.current) };
    state.current = current;
    setLoadingSession(sessionId);
    current.ready = current.ready.then(value => {
      if (state.current === current) setSelection({ id: sessionId, value });
      return value;
    });
    void current.ready.catch(() => {
      if (state.current === current) optionsRef.current.onError?.(optionsRef.current.errorMessage);
    });
    const read = current.ready;
    const settled = () => {
      if (state.current === current && current.ready === read) setLoadingSession(null);
    };
    void read.then(settled, settled);
    return () => { if (state.current === current) state.current = null; };
  }, [sessionId]);
  const setValue = useCallback((value: T) => {
    if (!sessionId || state.current?.id !== sessionId) return;
    const current = state.current;
    setLoadingSession(sessionId);
    const operation = current.ready.catch(() => undefined).then(() => request(sessionId, optionsRef.current, value)).then(saved => {
      if (state.current === current) setSelection({ id: sessionId, value: saved });
      return saved;
    });
    current.ready = operation;
    const settled = () => {
      if (state.current === current && current.ready === operation) setLoadingSession(null);
    };
    void operation.then(settled, settled);
    void operation.catch(() => {
      if (state.current === current) optionsRef.current.onError?.(optionsRef.current.errorMessage);
    });
  }, [sessionId]);
  const freeze = useCallback((): Promise<T> => {
    if (!sessionId || state.current?.id !== sessionId) return Promise.reject(new Error(optionsRef.current.errorMessage));
    return state.current.ready;
  }, [sessionId]);
  return {
    value: selection?.id === sessionId ? selection.value : null,
    loading: !!sessionId && loadingSession === sessionId,
    setValue,
    freeze,
  };
}

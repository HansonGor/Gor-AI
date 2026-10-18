import { useEffect, useState } from 'react';

/** 服务端模型注册表中的一项（不含地址与密钥）。 */
export type ChatModelOption = {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  description: string;
  supports_tools: boolean;
  supports_thinking: boolean;
  default: boolean;
  available: boolean;
};

type Catalog = { models: ChatModelOption[]; defaultModelId: string | null };
let cached: Promise<Catalog> | null = null;

function loadCatalog(): Promise<Catalog> {
  if (!cached) {
    cached = fetch('/api/chat/models', { cache: 'no-store' })
      .then(response => {
        if (!response.ok) throw new Error('模型列表读取失败。');
        return response.json();
      })
      .then(data => ({
        models: Array.isArray(data?.models) ? data.models : [],
        defaultModelId: typeof data?.defaultModelId === 'string' ? data.defaultModelId : null,
      }))
      .catch(error => { cached = null; throw error; });
  }
  return cached;
}

/** 可选模型列表：页面内共享一次请求；失败时允许下次重新读取。 */
export function useChatModels() {
  const [catalog, setCatalog] = useState<Catalog>({ models: [], defaultModelId: null });
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadCatalog().then(result => { if (alive) { setCatalog(result); setFailed(false); } },
      () => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, []);
  return { ...catalog, failed };
}

/** 仅供测试重置缓存。 */
export function resetChatModelsForTests() {
  cached = null;
}

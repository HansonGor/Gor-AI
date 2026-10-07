import type { GeneratedFile } from '../types.ts';
import { getChatClientMode } from '../utils/clientMode.ts';
import { glbFileName } from '../preview/core/artifactFormat.ts';

/** Web-only virtual artifact persistence; not a workspace write or a download. */
export async function saveGeneratedGlb(sessionId: string, blob: Blob, name: string, messageId?: string): Promise<GeneratedFile> {
  if (getChatClientMode() !== 'web') throw new Error('VS Code 工作区不使用 Web Preview 产物接口。');
  const query = new URLSearchParams({ name: glbFileName(name) });
  if (messageId) query.set('message_id', messageId);
  const response = await fetch(`/api/chat/session/${encodeURIComponent(sessionId)}/generated-artifacts?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'model/gltf-binary' },
    body: blob,
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success || !data.file) throw new Error(data.detail || 'GLB 虚拟产物保存失败，请重试。');
  return data.file as GeneratedFile;
}

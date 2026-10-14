import type { SaveFileOptions } from '../preview/core/saveFile';
import { postVscodeMessage } from './vscodeRuntime';

/** An explicit user download, through the host picker; no workspace/project write. */
export async function saveVscodeShareImage({
  suggestedName,
  blob,
}: SaveFileOptions): Promise<boolean> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > 32 * 1024 * 1024) throw new Error('分享图片超过保存限制，请减少选取内容。');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('message', receive);
      clearTimeout(timer);
    };
    const receive = (event: MessageEvent) => {
      const result = event.data;
      if (result?.type !== 'gor.shareImageSaved' || result.requestId !== requestId) return;
      cleanup();
      if (result.error) reject(new Error(result.error));
      else resolve(result.saved === true);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('保存未收到回执，请确认 VS Code 保存窗口。'));
    }, 120000);
    window.addEventListener('message', receive);
    if (
      !postVscodeMessage({
        type: 'gor.saveShareImage',
        requestId,
        suggestedName,
        base64: btoa(binary),
      })
    ) {
      cleanup();
      reject(new Error('VS Code 保存通道不可用。'));
    }
  });
}

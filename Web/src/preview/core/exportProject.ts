import { strToU8, zipSync } from 'fflate';
import type { PreviewFiles } from './types.ts';
import { normalizePreviewPath } from './pathUtils.ts';
import type { PreviewBuildResult } from '../runtime/workerProtocol.ts';

/** Export only the in-memory sources, never the host workspace or dependencies. */
export function createPreviewArchive(files: PreviewFiles): Uint8Array {
  const entries: Record<string, Uint8Array> = Object.create(null);
  for (const [path, content] of Object.entries(files)) {
    const name = normalizePreviewPath(path).slice(1);
    if (!name) throw new Error('Cannot export an empty file path.');
    entries[name] = strToU8(content);
  }
  return zipSync(entries, { level: 6 });
}

export function previewArchiveName(title: string): string {
  return `${
    title
      .replace(/\.html?$/i, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim() || 'Preview'
  }-source.zip`;
}

/** Export the exact successful build together with its local runtime as a standalone dist. */
export function createPreviewDistArchive(
  result: PreviewBuildResult,
  runtimeSource: string,
): Uint8Array {
  const javascript = result.outputFiles.find((file) => file.type === 'js')?.contents;
  if (!javascript) throw new Error('Build Result does not include JavaScript output.');
  const css = result.outputFiles.find((file) => file.type === 'css')?.contents ?? '';
  // Escape HTML end-tag openers so generated source cannot terminate its inline script.
  const inlineScript = (source: string) => source.replace(/<\/script/gi, '<\\/script');
  const cssLiteral = JSON.stringify(css).replace(/</g, '\\u003c');
  const document = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Preview</title>
    <style id="preview-styles"></style>
  </head>
  <body>
    <div id="root"></div>
    <script>document.getElementById('preview-styles').textContent = ${cssLiteral};</script>
    <script>${inlineScript(runtimeSource)}</script>
    <script>${inlineScript(javascript)}</script>
  </body>
</html>`;
  const entries: Record<string, Uint8Array> = Object.create(null);
  entries['index.html'] = strToU8(document);
  return zipSync(entries, { level: 6 });
}

export function previewDistArchiveName(title: string): string {
  return `${previewArchiveName(title).replace(/-source\.zip$/i, '')}-dist.zip`;
}

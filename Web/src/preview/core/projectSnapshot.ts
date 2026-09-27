import { createSceneProjectFiles, validateSceneSpec } from '../../modeling/sceneSpec.ts';
import type { PreviewProject, PreviewTemplate } from './types.ts';
import type { PreviewProjectSnapshot } from '../../types.ts';

const REACT_SOURCE_PATHS = ['/src/App.tsx', '/src/App.jsx', '/src/App.ts', '/src/App.js'];
const REACT_ENTRY_PATHS = ['/src/main.tsx', '/src/main.jsx', '/src/main.ts', '/src/main.js'];

function pointHtmlAtEntry(indexHtml: string, entryPath: string): string {
  const scriptTag = /(<script\b[^>]*\bsrc\s*=\s*["'])[^"']+(["'][^>]*>)/i;
  if (scriptTag.test(indexHtml)) return indexHtml.replace(scriptTag, `$1${entryPath}$2`);
  const moduleScript = `<script type="module" src="${entryPath}"></script>`;
  return /<\/body>/i.test(indexHtml)
    ? indexHtml.replace(/<\/body>/i, `${moduleScript}</body>`)
    : `${indexHtml}${moduleScript}`;
}

function projectNameFromHtml(indexHtml: string, fallback: string): string {
  const title = indexHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/<[^>]*>/g, '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .trim();
  return title && !/^gor (react )?preview$/i.test(title) ? title.slice(0, 80) : fallback;
}

/** Build an immutable, message-scoped source snapshot without stale files from another app kind. */
export function createMessagePreviewSnapshot(
  project: PreviewProject,
  messageId: string,
  changedPaths: string[],
): PreviewProjectSnapshot {
  const files = { ...project.files };

  if (changedPaths.includes('/src/scene.json')) {
    try {
      const scene = validateSceneSpec(JSON.parse(files['/src/scene.json'] ?? ''));
      return {
        messageId,
        id: project.id,
        name: scene.name,
        template: 'html',
        outputExtension: '.glb',
        files: createSceneProjectFiles(scene),
      };
    } catch {
      // Keep invalid scene data visible for diagnosis; never silently substitute another project.
    }
  }

  const hasReactChanges = changedPaths.some((path) =>
    REACT_SOURCE_PATHS.includes(path) || REACT_ENTRY_PATHS.some((entry) => path === entry) || path === '/src/style.css',
  );
  if (hasReactChanges) {
    // Scene projects and React apps used to share one Virtual FS. These paths are
    // infrastructure for the old project, not source dependencies of the React app.
    delete files['/src/scene.json'];
    if (files['/src/main.ts']?.includes('scene.json')) delete files['/src/main.ts'];

    const reactEntry = REACT_ENTRY_PATHS.find((path) => path !== '/src/main.ts' && files[path] !== undefined)
      ?? REACT_ENTRY_PATHS.find((path) => files[path] !== undefined)
      ?? '/src/main.tsx';
    const indexHtml = files['/index.html'] ?? '<!doctype html><html><body><div id="root"></div></body></html>';
    files['/index.html'] = pointHtmlAtEntry(indexHtml, reactEntry);
    return {
      messageId,
      id: project.id,
      name: projectNameFromHtml(files['/index.html'], project.name),
      template: 'react',
      outputExtension: '.html',
      files,
    };
  }

  return {
    messageId,
    id: project.id,
    name: project.name,
    template: project.template as PreviewTemplate,
    outputExtension: '.html',
    files,
  };
}

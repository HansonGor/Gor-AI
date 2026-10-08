import { createSceneProjectFiles, isSceneRendererProject, validateSceneSpec } from '../../modeling/sceneSpec.ts';
import type { PreviewProject, PreviewTemplate } from './types.ts';
import type { PreviewProjectSnapshot } from '../../types.ts';
import { hasBabelScripts } from './htmlScripts.ts';

const REACT_SOURCE_PATHS = ['/src/App.tsx', '/src/App.jsx', '/src/App.ts', '/src/App.js'];
const REACT_ENTRY_PATHS = ['/src/main.tsx', '/src/main.jsx', '/src/main.ts', '/src/main.js'];

function pointHtmlAtEntry(indexHtml: string, entryPath: string): string {
  // Babel HTML needs all ordered scripts; never rewrite its first CDN script.
  if (hasBabelScripts(indexHtml)) return indexHtml;
  const scriptTag = /(<script\b(?=[^>]*\btype\s*=\s*["']module["'])[^>]*\bsrc\s*=\s*["'])[^"']+(["'][^>]*>)/i;
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

/** Reconcile the active entry after a compact source sync, not just its label. */
export function reconcilePreviewProject(project: PreviewProject, changedPaths: string[] = [], restoring = false): PreviewProject {
  const files = { ...project.files };
  const sceneChanged = changedPaths.includes('/src/scene.json');
  const reactChanged = changedPaths.some((path) => REACT_SOURCE_PATHS.includes(path) || REACT_ENTRY_PATHS.includes(path) && !files[path]?.includes("import spec from './scene.json'"));
  const hasReactEntry = REACT_ENTRY_PATHS.some((path) => files[path] !== undefined && !files[path].includes("import spec from './scene.json'"));
  if (sceneChanged || (restoring && files['/src/scene.json'] && (project.template === 'html' || !hasReactEntry))) {
    const scene = validateSceneSpec(JSON.parse(files['/src/scene.json']));
    return { ...project, name: scene.name, template: 'html', files: { ...files, ...createSceneProjectFiles(scene) } };
  }
  if (reactChanged || restoring && project.template === 'react' && hasReactEntry) {
    const savedEntry = files['/index.html']?.match(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    const entry = [...changedPaths].reverse().find((path) => REACT_ENTRY_PATHS.includes(path) && files[path] !== undefined)
      ?? (savedEntry && REACT_ENTRY_PATHS.includes(savedEntry) && files[savedEntry] !== undefined && !files[savedEntry].includes("import spec from './scene.json'") ? savedEntry : undefined)
      ?? REACT_ENTRY_PATHS.find((path) => files[path] !== undefined && !files[path].includes("import spec from './scene.json'"));
    if (!entry) return project; // Wait for the entry file to arrive; never invent React source.
    const fromScene = isSceneRendererProject(files) || project.template === 'html' && Boolean(files['/src/scene.json']);
    const appSource = REACT_SOURCE_PATHS.map((path) => files[path] ?? '').join('\n');
    const heading = appSource.match(/<h1\b[^>]*>([^<{]+)<\/h1>/i)?.[1]?.trim();
    const name = heading || (fromScene ? 'React Project' : project.name);
    let index = files['/index.html'] ?? '<!doctype html><html><head><meta charset="UTF-8"></head><body><div id="root"></div></body></html>';
    if (fromScene) index = index.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${name.replace(/[<>&"']/g, '')}</title>`);
    if (fromScene || !files['/index.html'] || !changedPaths.includes('/index.html') && changedPaths.some((path) => REACT_ENTRY_PATHS.includes(path))) {
      files['/index.html'] = pointHtmlAtEntry(index, entry);
    }
    return { ...project, name, template: 'react', files };
  }
  return project;
}

/** Build an immutable, message-scoped source snapshot without stale files from another app kind. */
export function createMessagePreviewSnapshot(
  project: PreviewProject,
  messageId: string,
  changedPaths: string[],
): PreviewProjectSnapshot {
  project = reconcilePreviewProject(project, changedPaths);
  const files = { ...project.files };
  const hasReactChanges = changedPaths.some((path) =>
    REACT_SOURCE_PATHS.includes(path) || REACT_ENTRY_PATHS.some((entry) => path === entry) || path === '/src/style.css',
  );

  // A complete SceneSpec renderer is the GLB deliverable even if an older
  // message did not persist the scene.json change path. React edits still win
  // when the shared virtual project contains stale scene scaffolding.
  if ((changedPaths.includes('/src/scene.json') || !hasReactChanges) && isSceneRendererProject(files)) {
    try {
      const scene = validateSceneSpec(JSON.parse(files['/src/scene.json'] ?? ''));
      return {
        messageId,
        id: project.id,
        name: scene.name,
        template: 'html',
        outputExtension: '.glb',
        files: createSceneProjectFiles(scene),
        revision: project.revision,
      };
    } catch {
      // Keep invalid scene data visible for diagnosis; never silently substitute another project.
    }
  }

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
      revision: project.revision,
    };
  }

  return {
    messageId,
    id: project.id,
    name: project.name,
    template: project.template as PreviewTemplate,
    outputExtension: '.html',
    files,
    revision: project.revision,
  };
}

import type { GeneratedFile, PreviewProjectSnapshot } from '../../types.ts';

function normalizeExtension(extension: string | undefined): string | null {
  if (!extension) return null;
  const normalized = extension.trim().toLowerCase();
  if (!normalized) return null;
  return normalized.startsWith('.') ? normalized : `.${normalized}`;
}

export function fileExtension(name: string): string | null {
  const cleanName = name.split(/[?#]/, 1)[0] ?? '';
  const segments = cleanName.split(/[\\/]/);
  const basename = segments[segments.length - 1] ?? '';
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) return null;
  return normalizeExtension(basename.slice(dot));
}

/** Return the format users receive, not an internal source-file extension. */
export function previewSnapshotExtension(snapshot: PreviewProjectSnapshot): string {
  return normalizeExtension(snapshot.outputExtension)
    ?? (snapshot.files['/src/scene.json'] ? '.glb' : snapshot.template === 'react' ? '.html' : '.html');
}

function cleanArtifactTitle(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39);/gi, ' ')
    .replace(/\s*[·|｜—–-]\s*(?:(?:react|html|vite|web)\s*)?(?:demo|preview|app|project)\s*$/i, '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .slice(0, 48);
}

/** Name an artifact by its human-facing content title and its delivered file extension. */
export function previewArtifactName(
  project: { name: string; files: Record<string, string> },
  extension: string,
): string {
  const normalizedExtension = normalizeExtension(extension) ?? '.html';
  let sceneTitle = '';
  const sceneSource = project.files['/src/scene.json'];
  if (sceneSource) {
    try {
      const scene = JSON.parse(sceneSource) as { name?: unknown };
      if (typeof scene.name === 'string') sceneTitle = scene.name;
    } catch {
      // An invalid scene spec still gets a useful filename from the project name.
    }
  }

  const htmlTitle = project.files['/index.html']?.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const cleanedHtmlTitle = cleanArtifactTitle(htmlTitle);
  const isGenericHtmlTitle = /^(?:gor\s+)?(?:react|html|vite)?\s*(?:preview|app|project|demo)?$/i.test(cleanedHtmlTitle)
    || /^(?:react|html)\s+preview$/i.test(cleanedHtmlTitle);

  let contentTitle = sceneTitle || (!isGenericHtmlTitle ? cleanedHtmlTitle : '');
  if (!contentTitle && normalizedExtension === '.html') {
    const source = Object.values(project.files).join('\n');
    const city = source.match(/\bcity\s*[:=]\s*['"`]([^'"`]+)['"`]/i)?.[1]?.trim()
      ?? source.match(/广州|北京|上海|深圳|杭州|成都|重庆|武汉|南京|西安|天津|苏州|长沙|郑州|青岛|厦门|福州|昆明|贵阳|哈尔滨|沈阳|大连/u)?.[0];
    if (city && /天气|weather|气象|预报/i.test(source)) contentTitle = `${city}天气`;
    if (!contentTitle) {
      const heading = source.match(/<h1[^>]*>([^<]{1,80})<\/h1>/i)?.[1];
      if (heading && !/[{}]/.test(heading)) contentTitle = cleanArtifactTitle(heading);
    }
  }

  const fallback = cleanArtifactTitle(project.name).replace(/\.[^.]+$/, '');
  const title = (contentTitle || fallback || 'Preview').replace(/\.[^.]+$/, '');
  return `${title}${normalizedExtension}`;
}

function sameFiles(first: Record<string, string>, second: Record<string, string>): boolean {
  const firstPaths = Object.keys(first).sort();
  const secondPaths = Object.keys(second).sort();
  return firstPaths.length === secondPaths.length
    && firstPaths.every((path, index) => path === secondPaths[index] && first[path] === second[path]);
}

function canonicalScene(source: string | undefined): string | null {
  if (!source) return null;
  try {
    const sortKeys = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortKeys(item)]));
      }
      return value;
    };
    return JSON.stringify(sortKeys(JSON.parse(source)));
  } catch {
    return source.trim();
  }
}

function withoutStaleSceneScaffold(files: Record<string, string>): Record<string, string> {
  const sceneSource = files['/src/scene.json'];
  const sceneEntry = files['/src/main.ts'];
  const hasSceneScaffold = Boolean(sceneSource && sceneEntry
    && /scene\.json/.test(sceneEntry)
    && /THREE\.WebGLRenderer/.test(sceneEntry));
  if (!hasSceneScaffold) return files;
  return Object.fromEntries(Object.entries(files).filter(([path]) => path !== '/src/scene.json' && path !== '/src/main.ts'));
}

/**
 * A workspace may contain stale files from another stack. Compare the files that define the
 * delivered artifact (GLB scene data or app files), not workspace IDs or the whole shared tree.
 */
export function haveSamePreviewArtifactFiles(
  first: Record<string, string>,
  firstExtension: string,
  second: Record<string, string>,
  secondExtension: string,
): boolean {
  const firstExt = normalizeExtension(firstExtension);
  const secondExt = normalizeExtension(secondExtension);
  if (!firstExt || firstExt !== secondExt) return false;
  if (sameFiles(first, second)) return true;
  if (firstExt === '.glb') {
    const firstScene = canonicalScene(first['/src/scene.json']);
    return firstScene !== null && firstScene === canonicalScene(second['/src/scene.json']);
  }
  return sameFiles(withoutStaleSceneScaffold(first), withoutStaleSceneScaffold(second));
}

export function generatedFileExtension(file: GeneratedFile): string | null {
  return fileExtension(file.displayName)
    ?? (file.fileType === '3d' ? '.glb' : file.fileType === 'html' ? '.html' : null);
}

export function previewArtifactTooltip(name: string, extension: string | null): string {
  return extension ? `${name} · ${extension}` : name;
}

/** Project identity can change during reload; the final artifact name is the fallback identity. */
export function isSamePreviewArtifact(
  currentProjectId: string,
  currentArtifactName: string,
  snapshotProjectId: string,
  snapshotArtifactName: string,
): boolean {
  if (currentProjectId && currentProjectId === snapshotProjectId) return true;
  return currentArtifactName.trim().toLocaleLowerCase()
    === snapshotArtifactName.trim().toLocaleLowerCase();
}

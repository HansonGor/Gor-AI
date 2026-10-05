const TRAVERSAL_SEGMENT = '..';
const BINARY_PREVIEW_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.ico',
  '.pdf', '.zip', '.rar', '.7z', '.tar', '.gz', '.glb', '.gltf', '.obj', '.fbx', '.stl', '.wasm',
  '.ttf', '.otf', '.woff', '.woff2', '.eot', '.mp3', '.wav',
  '.ogg', '.mp4', '.mov', '.webm', '.pptx', '.docx', '.xlsx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.pyc',
]);

/** Preview source tools edit UTF-8 text, independent of its programming language. */
export function isEditablePreviewTextPath(path: string): boolean {
  try {
    const normalized = normalizePreviewPath(path);
    if (normalized !== path || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(path)) return false;
    if (path.slice(1).split('/').some((part) => /(^\.|node_modules|dist|build|generated|secret|credential|private|token|password)/i.test(part))) return false;
    return !BINARY_PREVIEW_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase());
  } catch {
    return false;
  }
}

export function normalizePreviewPath(path: string): string {
  if (typeof path !== 'string' || path.includes('\0')) {
    throw new Error('Preview path must be a valid string.');
  }

  const unixPath = path.trim().replace(/\\/g, '/');
  const segments = unixPath.split('/');
  if (segments.includes(TRAVERSAL_SEGMENT)) {
    throw new Error(`Preview path cannot traverse outside the virtual root: ${path}`);
  }

  const normalizedSegments = segments.filter((segment) => segment && segment !== '.');
  if (normalizedSegments.length === 0) {
    throw new Error('Preview path must point to a file below /.');
  }

  return `/${normalizedSegments.join('/')}`;
}

export function validatePreviewPath(path: string): boolean {
  try {
    normalizePreviewPath(path);
    return true;
  } catch {
    return false;
  }
}

export function resolvePreviewPath(baseDirectory: string, requestedPath: string): string {
  const normalizedBase = baseDirectory === '/' ? '/' : normalizePreviewPath(baseDirectory);
  const unixRequest = requestedPath.trim().replace(/\\/g, '/');
  if (unixRequest.startsWith('/')) return normalizePreviewPath(unixRequest);

  const segments = normalizedBase === '/' ? [] : normalizedBase.slice(1).split('/');
  for (const segment of unixRequest.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`Preview path cannot traverse outside the virtual root: ${requestedPath}`);
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  if (segments.length === 0) {
    throw new Error('Preview path must point to a file below /.');
  }
  return normalizePreviewPath(`/${segments.join('/')}`);
}

const TRAVERSAL_SEGMENT = '..';

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

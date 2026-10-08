import type { PreviewProject } from './types.ts';
import { BABEL_PREVIEW_ENTRY, hasBabelScripts, htmlScripts } from './htmlScripts.ts';

/** index.html declares the virtual module entry; its scripts are never executed by Parent. */
export function getPreviewEntryPoint(project: PreviewProject): string {
  const scripts = htmlScripts(project.files['/index.html'] ?? '');
  for (const script of scripts) {
    if (script.type !== 'module') continue;
    const src = script.src;
    if (src) return src.startsWith('./') ? `/${src.slice(2)}` : src;
  }
  if (hasBabelScripts(project.files['/index.html'] ?? '')) return BABEL_PREVIEW_ENTRY;
  const candidates = project.template === 'react'
    ? ['/src/main.tsx', '/src/main.jsx', '/src/main.ts', '/src/main.js']
    : ['/main.js', '/src/main.js', '/src/main.ts'];
  return candidates.find((path) => project.files[path] !== undefined) ?? candidates[0];
}

import type { PreviewProject } from './types.ts';

/** index.html declares the virtual module entry; its scripts are never executed by Parent. */
export function getPreviewEntryPoint(project: PreviewProject): string {
  const scripts = (project.files['/index.html'] ?? '').match(/<script\b[^>]*>/gi) ?? [];
  for (const script of scripts) {
    if (!/\btype\s*=\s*["']module["']/i.test(script)) continue;
    const src = script.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
    if (src) return src.startsWith('./') ? `/${src.slice(2)}` : src;
  }
  return project.template === 'react' ? '/src/main.tsx' : '/main.js';
}

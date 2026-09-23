import type { PreviewFiles, PreviewTemplate } from '../core/types.ts';
import { createHtmlTemplate } from './htmlTemplate.ts';
import { createReactTemplate } from './reactTemplate.ts';

export { createHtmlTemplate } from './htmlTemplate.ts';
export { createReactTemplate } from './reactTemplate.ts';

export function createTemplateFiles(template: PreviewTemplate): PreviewFiles {
  return template === 'html' ? createHtmlTemplate() : createReactTemplate();
}

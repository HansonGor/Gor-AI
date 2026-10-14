import type { CodeLanguage } from './languages';

const loaders = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
};
export const loadCodeLanguage = (language: CodeLanguage) => loaders[language]();

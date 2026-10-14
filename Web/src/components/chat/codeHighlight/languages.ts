const languages = {
  typescript: { label: 'TypeScript' },
  javascript: { label: 'JavaScript' },
  tsx: { label: 'TSX' },
  jsx: { label: 'JSX' },
  python: { label: 'Python' },
  html: { label: 'HTML' },
  css: { label: 'CSS' },
  json: { label: 'JSON' },
  sql: { label: 'SQL' },
  shellscript: { label: 'Bash' },
  vue: { label: 'Vue' },
};
export type CodeLanguage = keyof typeof languages;
export function codeLanguageFromPath(path: string | null): CodeLanguage | null {
  const extension = path?.split(/[\\/]/).pop()?.split('.').pop()?.toLowerCase();
  return resolveCodeLanguage(extension);
}
const aliases: Record<string, CodeLanguage> = {
  ts: 'typescript',
  js: 'javascript',
  py: 'python',
  sh: 'shellscript',
  bash: 'shellscript',
  shell: 'shellscript',
  zsh: 'shellscript',
};
export function resolveCodeLanguage(value?: string): CodeLanguage | null {
  const name = value?.trim().toLowerCase() ?? '';
  return Object.prototype.hasOwnProperty.call(aliases, name)
    ? aliases[name]
    : Object.prototype.hasOwnProperty.call(languages, name)
      ? (name as CodeLanguage)
      : null;
}
export function codeLanguageLabel(value?: string): string {
  const language = resolveCodeLanguage(value);
  return language ? languages[language].label : value?.trim().slice(0, 40) || 'Text';
}
export interface CodeToken {
  content: string;
  color?: string;
  fontStyle?: number;
}
export type CodeTokens = CodeToken[][];
// Larger blocks retain all text, but avoid excessive grammar/DOM work.
export const canHighlightCode = (code: string) =>
  code.length <= 100_000 && code.split('\n').length <= 2500;

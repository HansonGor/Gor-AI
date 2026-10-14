import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { CodeLanguage, CodeTokens } from './languages';
import { loadCodeLanguage } from './loadLanguage';

let instance: ReturnType<typeof createHighlighterCore> | undefined;
const loading = new Map<CodeLanguage, Promise<void>>();
function highlighter() {
  return (instance ??= createHighlighterCore({
    themes: [import('shiki/themes/dark-plus.mjs')],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  }));
}
export async function tokenizeCode(code: string, language: CodeLanguage): Promise<CodeTokens> {
  const shiki = await highlighter();
  if (!loading.has(language)) {
    const task = shiki.loadLanguage(loadCodeLanguage(language)).catch((error) => {
      loading.delete(language);
      throw error;
    });
    loading.set(language, task);
  }
  await loading.get(language);
  return shiki
    .codeToTokens(code, { lang: language, theme: 'dark-plus' })
    .tokens.map((line) =>
      line.map(({ content, color, fontStyle }) => ({ content, color, fontStyle })),
    );
}

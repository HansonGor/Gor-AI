// Single bundled file: VS Code Blob workers cannot import language chunks.
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import darkPlus from 'shiki/themes/dark-plus.mjs';
import type { HighlightRequest, HighlightReply } from './transport';
import type { CodeLanguage } from './languages';

const instance = createHighlighterCore({
  themes: [darkPlus],
  langs: [],
  engine: createJavaScriptRegexEngine(),
});
const loading = new Map<CodeLanguage, Promise<void>>();
const worker = self as unknown as {
  onmessage: (event: MessageEvent<HighlightRequest>) => void;
  postMessage: (reply: HighlightReply) => void;
};
worker.onmessage = async ({ data: { id, code, language, grammars } }) => {
  try {
    const shiki = await instance;
    if (!loading.has(language)) {
      if (!grammars) throw new Error('Missing language grammar');
      loading.set(language, shiki.loadLanguage(grammars));
    }
    await loading.get(language);
    const tokens = shiki
      .codeToTokens(code, { lang: language, theme: 'dark-plus' })
      .tokens.map((line) =>
        line.map(({ content, color, fontStyle }) => ({ content, color, fontStyle })),
      );
    worker.postMessage({ id, tokens });
  } catch {
    worker.postMessage({ id, tokens: null });
  }
};

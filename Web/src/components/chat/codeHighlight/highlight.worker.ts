import { tokenizeCode } from './runtime';
import type { CodeLanguage, CodeTokens } from './languages';
const worker = self as unknown as {
  onmessage: (event: MessageEvent<{ id: number; code: string; language: CodeLanguage }>) => void;
  postMessage: (value: { id: number; tokens: CodeTokens | null }) => void;
};
worker.onmessage = async ({ data: { id, code, language } }) => {
  try {
    worker.postMessage({ id, tokens: await tokenizeCode(code, language) });
  } catch {
    worker.postMessage({ id, tokens: null });
  }
};

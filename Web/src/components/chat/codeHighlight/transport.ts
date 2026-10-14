import type { LanguageRegistration } from 'shiki/core';
import type { CodeLanguage, CodeTokens } from './languages';

export interface HighlightRequest {
  id: number;
  code: string;
  language: CodeLanguage;
  grammars?: LanguageRegistration[];
}
export interface HighlightReply {
  id: number;
  tokens: CodeTokens | null;
}
export interface HighlightWorker {
  onmessage: ((event: MessageEvent<HighlightReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage: (request: HighlightRequest) => void;
  terminate: () => void;
}

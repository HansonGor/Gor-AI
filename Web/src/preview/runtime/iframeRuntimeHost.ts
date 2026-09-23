import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import * as THREE from 'three';
import type { ParentToRuntimeMessage, RuntimeConsoleLevel, RuntimeMetadata, RuntimeToParentMessage } from './runtimeProtocol.ts';
import { isParentToRuntimeMessage } from './runtimeProtocol.ts';
import { normalizeRuntimeError, serializeConsoleArgs } from './runtimeSerialization.ts';

declare global {
  interface Window {
    __GOR_PREVIEW_RUNTIME__?: {
      React: typeof React;
      ReactDOM: typeof ReactDOM;
      ReactDOMClient: typeof ReactDOMClient;
      jsxRuntime: typeof jsxRuntime;
      jsxDevRuntime: typeof jsxDevRuntime;
      THREE: typeof THREE;
    };
  }
}

window.__GOR_PREVIEW_RUNTIME__ = { React, ReactDOM, ReactDOMClient, jsxRuntime, jsxDevRuntime, THREE };

let active: RuntimeMetadata | null = null;
let currentStyle: HTMLStyleElement | null = null;

function send(message: RuntimeToParentMessage): void {
  window.parent.postMessage(message, '*');
}

const hostRuntimeId = new URLSearchParams(window.location.search).get('runtime');
if (hostRuntimeId) send({ type: 'RUNTIME_HOST_READY', runtimeId: hostRuntimeId });

function sameRun(message: RuntimeMetadata): boolean {
  return active !== null
    && active.runtimeId === message.runtimeId
    && active.projectId === message.projectId
    && active.buildId === message.buildId;
}

function reportError(error: unknown, location: { source?: string | null; line?: number | null; column?: number | null } = {}): void {
  if (!active) return;
  send({ type: 'RUNTIME_ERROR', ...active, error: normalizeRuntimeError(error, active, location) });
}

(['log', 'info', 'warn', 'error'] as const).forEach((level: RuntimeConsoleLevel) => {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    if (active) send({ type: 'RUNTIME_CONSOLE', ...active, entry: { ...active, level, args: serializeConsoleArgs(args), timestamp: Date.now() } });
  };
});

window.addEventListener('error', (event) => {
  reportError(event.error ?? new Error(event.message), { source: event.filename || null, line: event.lineno || null, column: event.colno || null });
});
window.addEventListener('unhandledrejection', (event) => {
  reportError(event.reason);
});

function resetDocument(): void {
  document.getElementById('root')?.replaceChildren();
  currentStyle?.remove();
  currentStyle = null;
}

async function run(message: Extract<ParentToRuntimeMessage, { type: 'RUNTIME_RUN' }>): Promise<void> {
  if (!sameRun(message)) return;
  resetDocument();
  if (message.css) {
    currentStyle = document.createElement('style');
    currentStyle.textContent = message.css;
    document.head.append(currentStyle);
  }
  const metadata: RuntimeMetadata = { runtimeId: message.runtimeId, projectId: message.projectId, buildId: message.buildId };
  send({ type: 'RUNTIME_STARTED', ...metadata });
  const url = URL.createObjectURL(new Blob([message.javascript], { type: 'text/javascript' }));
  try {
    await import(/* @vite-ignore */ url);
    if (sameRun(message)) send({ type: 'RUNTIME_SUCCESS', ...metadata });
  } catch (error) {
    reportError(error, { source: 'preview-bundle.js' });
  } finally {
    URL.revokeObjectURL(url);
  }
}

window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (event.source !== window.parent || !isParentToRuntimeMessage(event.data)) return;
  const message = event.data;
  if (message.type === 'RUNTIME_INIT') {
    active = { runtimeId: message.runtimeId, projectId: message.projectId, buildId: message.buildId };
    send({ type: 'RUNTIME_READY', ...active });
    return;
  }
  if (!sameRun(message)) return;
  if (message.type === 'RUNTIME_RESET') {
    resetDocument();
    return;
  }
  void run(message);
});

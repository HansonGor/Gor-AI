import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import * as jsxDevRuntime from 'react/jsx-dev-runtime';
import * as THREE from 'three';

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

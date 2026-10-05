import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(root, '../vscode-extension/media/chat');
const publicAssets = [
  'images/gor-avatar.png',
  'images/gor-header-logo.png',
  'images/gor-welcome-mark.png',
  'images/jiangnan-chat-bg.png',
  'images/session-cache-moon-ring.png',
  'preview-runtime-dist/preview-runtime.js',
];

function copyChatAssets() {
  return {
    name: 'copy-gor-chat-public-assets',
    async closeBundle() {
      for (const relativePath of publicAssets) {
        const source = path.join(root, 'public', relativePath);
        const destination = path.join(outDir, relativePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(source, destination);
      }
    },
  };
}

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  plugins: [react(), copyChatAssets()],
  resolve: {
    alias: {
      '@': path.resolve(root, './src'),
    },
  },
  css: {
    preprocessorOptions: {
      less: {
        javascriptEnabled: true,
      },
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        vscode: path.resolve(root, 'vscode.html'),
        'preview-runtime': path.resolve(root, 'preview-runtime.html'),
      },
    },
  },
});

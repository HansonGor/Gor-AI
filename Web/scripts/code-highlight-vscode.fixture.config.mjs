import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('../', import.meta.url)),
  base: './',
  publicDir: false,
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    outDir: fileURLToPath(new URL('../../.runlogs/vscode-shiki-fixture', import.meta.url)),
    emptyOutDir: false,
    rollupOptions: {
      input: fileURLToPath(new URL('./code-highlight-vscode.fixture.html', import.meta.url)),
    },
  },
});

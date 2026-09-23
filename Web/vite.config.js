import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  // The compiler is loaded from a Worker, outside Vite's normal page scan.
  // Prebundle it before chat starts so first preview never reloads the Parent
  // and discards its in-memory Virtual FS mid-SSE.
  optimizeDeps: {
    entries: ['index.html', 'preview-runtime.html'],
    include: ['esbuild-wasm', 'three', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
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
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'preview-runtime': path.resolve(__dirname, 'preview-runtime.html'),
      },
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // The Runtime iframe intentionally has an opaque sandbox origin. Its trusted,
    // local ES module host therefore needs a CORS response while developing.
    cors: true,
    hmr: { overlay: false },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  preview: { cors: true },
});

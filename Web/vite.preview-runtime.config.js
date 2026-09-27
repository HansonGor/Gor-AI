import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  configFile: false,
  publicDir: false,
  // React's production bundles read this at module startup; unlike the main
  // Vite app, this standalone library build does not inject it automatically.
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    outDir: path.resolve(__dirname, 'public/preview-runtime-dist'),
    emptyOutDir: true,
    minify: true,
    lib: {
      entry: path.resolve(__dirname, 'src/preview/runtime/standaloneRuntime.ts'),
      name: 'GorPreviewRuntime',
      formats: ['iife'],
      fileName: () => 'preview-runtime.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

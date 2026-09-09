import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'public/sandbox',
    emptyOutDir: false,
    minify: 'esbuild',
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL('./src/sandbox/runtime.ts', import.meta.url)),
      name: 'LLM3DSandbox',
      formats: ['iife'],
      fileName: () => 'runtime.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});

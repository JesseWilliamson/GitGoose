import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'

// Workspace packages ship TypeScript source, so they must be bundled, never left as externals.
const workspace = ['@gitgoose/codegraph', '@gitgoose/git', '@gitgoose/graph', '@gitgoose/shared']

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: workspace },
      // Two entries: the main process, and the code indexer it runs as a utility process.
      rolldownOptions: { input: { index: resolve(import.meta.dirname, 'src/main/index.ts'), indexer: resolve(import.meta.dirname, 'src/main/indexer.ts') } },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: workspace },
      // Sandboxed preload scripts cannot be ES modules, so emit CommonJS (.cjs, because this
      // package is "type": "module").
      rolldownOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    // Smaller bundles parse faster, and startup time is a feature here.
    build: { minify: true },
  },
})

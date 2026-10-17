import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

// Workspace packages ship TypeScript source, so they must be bundled, never left as externals.
const workspace = ['@gitsquid/git', '@gitsquid/graph', '@gitsquid/shared']

export default defineConfig({
  main: {
    build: { externalizeDeps: { exclude: workspace } },
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

import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // relative asset URLs, so the site works under /<repo>/ on GitHub Pages and from a file: URL
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // one HTML page per URL: a static site, no router
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        how: resolve(import.meta.dirname, 'how-it-works/index.html'),
        graphs: resolve(import.meta.dirname, 'graphs/index.html'),
      },
    },
  },
})

import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

/**
 * dsviz (the diagram library, github.com/JesseWilliamson/DiagramBuilder) is not published to npm
 * yet, so the site reads its packages straight from a checkout beside this repository, exactly as
 * dsviz's own docs site does. Once it is published, replace the alias with normal dependencies.
 */
export const DSVIZ = resolve(__dirname, '../../../DiagramBuilder')
if (!existsSync(resolve(DSVIZ, 'packages/core/src/index.ts'))) {
  throw new Error(`dsviz not found at ${DSVIZ}: clone github.com/JesseWilliamson/DiagramBuilder beside this repository`)
}

export default defineConfig({
  plugins: [react()],
  // relative asset URLs, so the site works under /<repo>/ on GitHub Pages and from a file: URL
  base: './',
  resolve: {
    alias: [{ find: /^@dsviz\/(.*)$/, replacement: resolve(DSVIZ, 'packages/$1/src/index.ts') }],
    // dsviz's sources sit outside this package: resolve React (and Radix) from here, never from
    // its node_modules, or there would be two Reacts and every hook would throw
    dedupe: ['react', 'react-dom', '@radix-ui/react-select', '@radix-ui/react-slider', '@radix-ui/react-switch', '@radix-ui/react-toggle-group'],
  },
  server: { fs: { allow: [resolve(__dirname), DSVIZ] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      // one HTML page per URL: a static site, no router
      input: {
        home: resolve(__dirname, 'index.html'),
        how: resolve(__dirname, 'how-it-works/index.html'),
        graphs: resolve(__dirname, 'graphs/index.html'),
      },
    },
  },
})

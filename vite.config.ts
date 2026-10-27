import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync } from 'fs'

const rendererRoot = resolve(__dirname, 'src/renderer')
const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))

export default defineConfig({
  plugins: [
    react(),
    {
      // Splash 的静态兜底版本号来自 package.json.version，构建 / dev 时替换占位符。
      name: 'inject-app-version',
      transformIndexHtml(html) {
        return html.replace(/%APP_VERSION%/g, pkg.version)
      },
    },
  ],
  root: 'src/renderer',
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __ELECTRON_VERSION__: JSON.stringify(pkg.devDependencies.electron),
  },
  build: {
    outDir: '../../dist/src/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(rendererRoot, 'index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    port: 5173,
  },
})

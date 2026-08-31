import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared, '@main': resolve(__dirname, 'electron') } },
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'electron/main/index.ts') },
      rollupOptions: { external: ['node:sqlite'] }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { outDir: 'out/preload', lib: { entry: resolve(__dirname, 'electron/preload/index.ts') } }
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    resolve: { alias: { '@': resolve(__dirname, 'src'), '@shared': shared } },
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'src/index.html') }
    }
  }
})

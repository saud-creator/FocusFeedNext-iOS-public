import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { APP_VERSION, BUILD_NUMBER, SOURCE_COMMIT } from './vite.version.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __FFN_UI_TEST__: process.env.FFN_UI_TEST === '1',
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
    'import.meta.env.VITE_BUILD_NUMBER': JSON.stringify(BUILD_NUMBER),
    'import.meta.env.VITE_SOURCE_COMMIT': JSON.stringify(SOURCE_COMMIT),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Tauri expects a fixed port and clear errors.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    // The portable EXE keeps a transient WebView profile under dist-portable.
    // Watching that live database makes Vite fail with EBUSY while the app is
    // open, and it provides no source files useful to hot reload.
    watch: {
      ignored: ["**/dist-portable/**", "**/dist-ios/**", "**/supercord/**", "**/src-tauri/target/**"],
    },
  },
  build: {
    // Match the minimum supported iOS WebKit as well as desktop WebView2.
    target: ['safari16', 'chrome109'],
    chunkSizeWarningLimit: 1200,
  },
})

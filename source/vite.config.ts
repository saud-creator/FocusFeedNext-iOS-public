import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'
import { APP_VERSION } from './vite.version.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(APP_VERSION),
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
    // WebView2 on Windows supports modern output.
    target: 'esnext',
    chunkSizeWarningLimit: 1200,
  },
})

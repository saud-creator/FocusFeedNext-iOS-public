/**
 * The Vite build injects this value from package.json. Keeping the display
 * value build-time makes it available immediately, including when the app is
 * running without a live Tauri command bridge.
 */
export const APP_VERSION = import.meta.env.VITE_APP_VERSION
export const BUILD_NUMBER = import.meta.env.VITE_BUILD_NUMBER || 'local'
export const SOURCE_COMMIT = import.meta.env.VITE_SOURCE_COMMIT || 'local'

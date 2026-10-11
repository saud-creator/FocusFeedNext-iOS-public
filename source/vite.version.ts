import { readFileSync } from 'node:fs'

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version?: unknown }

if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
  throw new Error('package.json must contain a non-empty version')
}

/** The version embedded into every Vite-rendered screen. */
export const APP_VERSION = packageJson.version

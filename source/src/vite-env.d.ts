declare const __FFN_UI_TEST__: boolean;
interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string
  readonly VITE_BUILD_NUMBER: string
  readonly VITE_SOURCE_COMMIT: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

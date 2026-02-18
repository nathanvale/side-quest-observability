/// <reference types="vite/client" />

/**
 * Vite environment variable type declarations.
 *
 * Why: TypeScript needs to know about VITE_* env vars at compile time.
 * Declaring them here gives type-safe access via import.meta.env.
 */
interface ImportMetaEnv {
	readonly VITE_SERVER_URL: string
	readonly VITE_MAX_EVENTS: string
	readonly VITE_PORT: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

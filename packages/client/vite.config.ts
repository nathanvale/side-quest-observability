import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * Vite configuration for the observability dashboard.
 *
 * Why no proxy: OBS-1 server already adds CORS headers
 * (Access-Control-Allow-Origin: *), so the dashboard on :5173
 * can reach the server on :7483 directly. Using a proxy would
 * hide integration bugs behind a dev-only mechanism and create
 * a different connection path from production.
 */
export default defineConfig({
	plugins: [vue(), tailwindcss()],
	server: {
		port: Number.parseInt(process.env.VITE_PORT ?? '5173', 10),
		// No proxy -- direct CORS connection to the event server
	},
})

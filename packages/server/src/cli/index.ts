#!/usr/bin/env bun

/**
 * CLI entry point for the observability server.
 *
 * Why: Provides the `observability server` command so the event bus
 * can be started from the shell or from Claude Code hook configuration.
 * The hook scripts are fully self-contained and do not import this package;
 * they only need a running server.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Server } from 'bun'
import { readEventServerPort, startServer } from '../server.js'

const DEFAULT_PORT = 7483
const DEFAULT_HOSTNAME = '127.0.0.1'

/**
 * Source of the configured CLI port.
 *
 * Why: Distinguishes explicit user intent (`arg`/`env`) from defaults so
 * we can handle "already running on another port" scenarios ergonomically.
 */
type PortSource = 'default' | 'env' | 'arg'

/**
 * Normalized CLI options for `observability server`.
 */
export interface CliStartOptions {
	readonly command: 'server'
	readonly port: number
	readonly hostname: string
	readonly portSource: PortSource
}

/**
 * Parsed CLI result.
 *
 * Why: Keeps parsing and execution separate so argument handling is easy to
 * unit test without binding sockets.
 */
export type CliParseResult =
	| { readonly ok: true; readonly options: CliStartOptions }
	| { readonly ok: false; readonly exitCode: number; readonly output: string }

/**
 * Parse CLI arguments for the observability command.
 *
 * Supports:
 * - `observability server`
 * - `observability server --port 7512`
 * - `observability server --port=7512`
 * - `observability server --host 0.0.0.0`
 * - `observability --help`
 *
 * Environment fallback:
 * - `OBSERVABILITY_PORT`
 * - `PORT`
 *
 * @param argv - Raw process arguments (`process.argv`)
 * @returns Parsed options or usage/error text with an exit code
 */
export function parseCliArgs(argv: readonly string[]): CliParseResult {
	const args = argv.slice(2)

	if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
		return { ok: false, exitCode: 0, output: usageText() }
	}

	const command = args[0]
	if (command !== 'server') {
		return {
			ok: false,
			exitCode: 1,
			output: `Unknown command: ${command}\n\n${usageText()}`,
		}
	}

	let portValue: string | null = null
	let portSource: PortSource = 'default'
	let hostname = DEFAULT_HOSTNAME

	for (let i = 1; i < args.length; i++) {
		const token = args[i]
		if (!token) continue

		if (token === '--help' || token === '-h') {
			return { ok: false, exitCode: 0, output: usageText() }
		}

		if (token === '--port') {
			const value = args[i + 1]
			if (!value) {
				return {
					ok: false,
					exitCode: 1,
					output: `Missing value for --port\n\n${usageText()}`,
				}
			}
			portValue = value
			portSource = 'arg'
			i++
			continue
		}

		if (token.startsWith('--port=')) {
			portValue = token.slice('--port='.length)
			portSource = 'arg'
			continue
		}

		if (token === '--host' || token === '--hostname') {
			const value = args[i + 1]
			if (!value) {
				return {
					ok: false,
					exitCode: 1,
					output: `Missing value for ${token}\n\n${usageText()}`,
				}
			}
			hostname = value
			i++
			continue
		}

		if (token.startsWith('--host=')) {
			hostname = token.slice('--host='.length)
			continue
		}

		if (token.startsWith('--hostname=')) {
			hostname = token.slice('--hostname='.length)
			continue
		}

		return {
			ok: false,
			exitCode: 1,
			output: `Unknown option: ${token}\n\n${usageText()}`,
		}
	}

	if (portValue === null) {
		const envPort = process.env.OBSERVABILITY_PORT ?? process.env.PORT
		if (envPort && envPort.trim() !== '') {
			portValue = envPort.trim()
			portSource = 'env'
		}
	}

	const parsedPort = portValue ? parsePort(portValue) : DEFAULT_PORT
	if (parsedPort === null) {
		return {
			ok: false,
			exitCode: 1,
			output: `Invalid port: ${portValue}\nPort must be an integer between 0 and 65535.\n\n${usageText()}`,
		}
	}

	if (!hostname.trim()) {
		return {
			ok: false,
			exitCode: 1,
			output: `Invalid host: ${hostname}\nHost cannot be empty.\n\n${usageText()}`,
		}
	}

	return {
		ok: true,
		options: {
			command: 'server',
			port: parsedPort,
			hostname,
			portSource,
		},
	}
}

/**
 * Run the observability CLI command.
 *
 * Why: Returning an exit code (instead of immediately calling process.exit)
 * keeps the function testable and allows cleaner control flow.
 *
 * @param argv - Raw process arguments (`process.argv`)
 * @returns Exit code for one-shot execution paths (help, validation errors)
 */
export async function main(
	argv: readonly string[] = process.argv,
): Promise<number> {
	const parsed = parseCliArgs(argv)
	if (!parsed.ok) {
		const stream = parsed.exitCode === 0 ? process.stdout : process.stderr
		stream.write(`${parsed.output}\n`)
		return parsed.exitCode
	}

	const { hostname, port, portSource } = parsed.options

	const existingPort = readEventServerPort()
	if (existingPort !== null) {
		if (portSource !== 'default' && port !== existingPort) {
			process.stderr.write(
				[
					`[observability] A server is already running on port ${existingPort}.`,
					`[observability] Requested port ${port} conflicts with the active instance.`,
					`[observability] Stop the existing server first, or connect to http://${displayHost(hostname)}:${existingPort}`,
				].join('\n') + '\n',
			)
			return 1
		}

		const baseUrl = `http://${displayHost(hostname)}:${existingPort}`
		process.stdout.write(
			[
				`[observability] Server already running: ${baseUrl}`,
				`[observability] Dashboard: ${baseUrl}/`,
				`[observability] Health:    ${baseUrl}/health`,
			].join('\n') + '\n',
		)
		return 0
	}

	try {
		const server = startServer({
			appName: 'side-quest-observability',
			port,
			hostname,
			// CLI bundle lives in dist/cli; dashboard assets are copied to dist/public.
			dashboardDistDir: join(import.meta.dir, '../public'),
		})

		printStartupSummary(server, hostname, port)
		return 0
	} catch (err) {
		process.stderr.write(`${formatStartError(err, hostname, port)}\n`)
		return 1
	}
}

/**
 * Convert a raw port string to an integer.
 *
 * Accepts `0` for explicit auto-assigned ports (mainly test/dev use).
 *
 * @param raw - Raw port token from args or env
 * @returns Parsed port integer, or null when invalid
 */
function parsePort(raw: string): number | null {
	if (!/^\d+$/.test(raw)) return null
	const port = Number.parseInt(raw, 10)
	if (!Number.isInteger(port) || port < 0 || port > 65_535) return null
	return port
}

/**
 * Build CLI usage text.
 *
 * @returns Human-readable usage text for stdout/stderr
 */
function usageText(): string {
	return [
		'Usage:',
		'  observability server [--port PORT] [--host HOST]',
		'',
		'Options:',
		'  --port <PORT>          Listen port (0-65535, default: 7483)',
		'  --host, --hostname     Bind host (default: 127.0.0.1)',
		'  -h, --help             Show this help',
		'',
		'Environment:',
		'  OBSERVABILITY_PORT     Default port when --port is omitted',
		'  PORT                   Fallback default port when OBSERVABILITY_PORT is unset',
		'',
		'Examples:',
		'  bunx @side-quest/observability-server server',
		'  bunx @side-quest/observability-server server --port 7512',
		'  bunx @side-quest/observability-server server --host 0.0.0.0',
	].join('\n')
}

/**
 * Format a startup failure into an actionable message.
 *
 * @param err - Unknown startup error
 * @param hostname - Requested bind hostname
 * @param port - Requested bind port
 * @returns User-facing error message
 */
function formatStartError(
	err: unknown,
	hostname: string,
	port: number,
): string {
	const message = err instanceof Error ? err.message : String(err)
	const display = `${displayHost(hostname)}:${port}`

	if (message.includes('EADDRINUSE') || message.includes('in use')) {
		return [
			`[observability] Failed to bind ${display}. Another process is already listening on this port.`,
			`[observability] Try a different port: observability server --port ${nextPortSuggestion(port)}`,
		].join('\n')
	}

	if (message.includes('Event server already running on port')) {
		return `[observability] ${message}`
	}

	return `[observability] Failed to start server: ${message}`
}

/**
 * Print startup endpoints and runtime hints.
 *
 * @param server - Running Bun server
 * @param hostname - Requested bind hostname
 * @param requestedPort - Requested bind port
 */
function printStartupSummary(
	server: Server<unknown>,
	hostname: string,
	requestedPort: number,
): void {
	const actualPort = server.port ?? requestedPort
	const host = displayHost(hostname)
	const baseUrl = `http://${host}:${actualPort}`

	process.stdout.write(
		[
			`[observability] Server running at ${baseUrl}`,
			`[observability] Dashboard: ${baseUrl}/`,
			`[observability] Health:    ${baseUrl}/health`,
			`[observability] Events:    ${baseUrl}/events`,
			`[observability] WebSocket: ${baseUrl.replace(/^http/, 'ws')}/ws`,
			'[observability] Stop with Ctrl+C',
		].join('\n') + '\n',
	)

	const dashboardIndex = join(import.meta.dir, '../public/index.html')
	if (!existsSync(dashboardIndex)) {
		process.stderr.write(
			`[observability] Warning: dashboard assets not found at ${dashboardIndex}. "/" will return 404.\n`,
		)
	}
}

/**
 * Convert bind hostname to a user-facing URL host segment.
 *
 * @param hostname - Bind hostname
 * @returns URL-friendly host shown to users
 */
function displayHost(hostname: string): string {
	if (hostname === '0.0.0.0') return '127.0.0.1'
	if (hostname === '::') return '[::1]'
	if (hostname.includes(':') && !hostname.startsWith('[')) {
		return `[${hostname}]`
	}
	return hostname
}

/**
 * Suggest a nearby alternative port.
 *
 * @param currentPort - Current requested port
 * @returns Suggested alternative port in range
 */
function nextPortSuggestion(currentPort: number): number {
	if (currentPort < 65_535) return currentPort + 1
	return DEFAULT_PORT + 1
}

if (import.meta.main) {
	main()
		.then((exitCode) => {
			if (exitCode !== 0) {
				process.exit(exitCode)
			}
		})
		.catch((err) => {
			process.stderr.write(`[observability] Unexpected CLI failure: ${err}\n`)
			process.exit(1)
		})
}

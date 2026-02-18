import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { isatty } from 'node:tty'
import { readEventServerPort, startServer } from '../server.js'

const DEFAULT_PORT = 7483
const DEFAULT_HOSTNAME = '127.0.0.1'
const STOP_TIMEOUT_MS = 3_000

const EXIT_OK = 0
const EXIT_RUNTIME = 1
const EXIT_USAGE = 2
const EXIT_NOT_FOUND = 3
const EXIT_UNAUTHORIZED = 4
const EXIT_CONFLICT = 5
const EXIT_INTERRUPTED = 130

const GLOBAL_CACHE_DIR = join(
	os.homedir(),
	'.cache',
	'side-quest-observability',
)
const PID_FILE = join(GLOBAL_CACHE_DIR, 'events.pid')
const PORT_FILE = join(GLOBAL_CACHE_DIR, 'events.port')
const NONCE_FILE = join(GLOBAL_CACHE_DIR, 'events.nonce')

type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 130
type CommandName = 'start' | 'status' | 'stop' | 'events'
type PortSource = 'default' | 'env' | 'arg'
type HelpTopic =
	| 'overview'
	| 'start'
	| 'status'
	| 'stop'
	| 'events'
	| 'api'
	| 'contract'

interface GlobalFlags {
	readonly json: boolean
	readonly quiet: boolean
	readonly nonInteractive: boolean
}

interface StartCommand extends GlobalFlags {
	readonly command: 'start'
	readonly port: number
	readonly hostname: string
	readonly portSource: PortSource
}

interface StatusCommand extends GlobalFlags {
	readonly command: 'status'
}

interface StopCommand extends GlobalFlags {
	readonly command: 'stop'
}

interface EventsCommand extends GlobalFlags {
	readonly command: 'events'
	readonly jsonl: boolean
	readonly typeFilter: string | null
	readonly since: string | null
	readonly limit: number | null
	readonly fields: readonly string[] | null
}

type CliOptions = StartCommand | StatusCommand | StopCommand | EventsCommand

interface ParseCliError {
	readonly ok: false
	readonly exitCode: ExitCode
	readonly message: string
	readonly output: string
	readonly errorCode: string
	readonly json: boolean
	readonly quiet: boolean
}

interface ParseCliOk {
	readonly ok: true
	readonly options: CliOptions
}

export type ParseCliResult = ParseCliError | ParseCliOk

interface DiscoveryState {
	readonly pid: number | null
	readonly port: number | null
	readonly nonce: string | null
}

interface OutputContext {
	readonly json: boolean
	readonly quiet: boolean
}

interface JsonErrorBody {
	readonly status: 'error'
	readonly message: string
	readonly error: {
		readonly name: string
		readonly code: string
	}
}

interface StartSuccessData {
	readonly command: 'start'
	readonly reusedExistingServer: boolean
	readonly pid: number | null
	readonly port: number
	readonly hostname: string
	readonly baseUrl: string
	readonly dashboardUrl: string
	readonly healthUrl: string
	readonly eventsUrl: string
	readonly wsUrl: string
	readonly portSource: PortSource
}

interface StatusSuccessData {
	readonly command: 'status'
	readonly running: true
	readonly pid: number | null
	readonly port: number
	readonly baseUrl: string
	readonly health: unknown
}

interface StopSuccessData {
	readonly command: 'stop'
	readonly stopped: true
	readonly pid: number
	readonly port: number
}

interface EventsSuccessData {
	readonly command: 'events'
	readonly count: number
	readonly events: readonly unknown[]
	readonly filters: {
		readonly type: string | null
		readonly since: string | null
		readonly limit: number | null
		readonly fields: readonly string[] | null
	}
}

/**
 * Parse CLI arguments for observability server commands.
 *
 * Why: Manual parsing keeps the runtime dependency-free while supporting
 * the command/flag shapes required for both humans and agents.
 */
export function parseCliArgs(argv: string[]): ParseCliResult {
	const args = argv.slice(2)
	let json = false
	let quiet = false
	let nonInteractive = false

	let commandToken: string | null = null
	const extraPositionals: string[] = []
	let portRaw: string | null = null
	let hostname = DEFAULT_HOSTNAME
	let jsonl = false
	let typeFilter: string | null = null
	let since: string | null = null
	let limitRaw: string | null = null
	let fieldsRaw: string | null = null

	if (args.length === 0) {
		return parseHelp(false, false)
	}

	for (let i = 0; i < args.length; i++) {
		const token = args[i]
		if (!token) continue

		if (token === '-h' || token === '--help') {
			const inlineTopic = args[i + 1]
			if (inlineTopic && !inlineTopic.startsWith('-')) {
				const topic = normalizeHelpTopic(inlineTopic)
				if (!topic) {
					return parseUsageError(
						`Unknown help topic: ${inlineTopic}`,
						usageText(),
						json,
						quiet,
					)
				}
				return parseHelp(json, quiet, topic)
			}

			if (commandToken !== null) {
				const commandTopic = normalizeHelpTopic(
					commandToken === 'server' ? 'start' : commandToken,
				)
				if (commandTopic) {
					return parseHelp(json, quiet, commandTopic)
				}
			}

			return parseHelp(json, quiet)
		}

		if (token === '--json') {
			json = true
			continue
		}

		if (token === '--quiet') {
			quiet = true
			continue
		}

		if (token === '--non-interactive') {
			nonInteractive = true
			continue
		}

		if (token === '--jsonl') {
			jsonl = true
			continue
		}

		if (token === '--port') {
			const value = args[i + 1]
			if (!value || value.startsWith('--')) {
				return parseUsageError(
					'Missing value for --port',
					usageText(),
					json,
					quiet,
				)
			}
			portRaw = value
			i++
			continue
		}

		if (token.startsWith('--port=')) {
			const value = token.slice('--port='.length)
			if (!value) {
				return parseUsageError(
					'Missing value for --port',
					usageText(),
					json,
					quiet,
				)
			}
			portRaw = value
			continue
		}

		if (token === '--host' || token === '--hostname') {
			const value = args[i + 1]
			if (!value || value.startsWith('--')) {
				return parseUsageError(
					`Missing value for ${token}`,
					usageText(),
					json,
					quiet,
				)
			}
			hostname = value
			i++
			continue
		}

		if (token.startsWith('--host=')) {
			const value = token.slice('--host='.length)
			if (!value) {
				return parseUsageError(
					'Missing value for --host',
					usageText(),
					json,
					quiet,
				)
			}
			hostname = value
			continue
		}

		if (token.startsWith('--hostname=')) {
			const value = token.slice('--hostname='.length)
			if (!value) {
				return parseUsageError(
					'Missing value for --hostname',
					usageText(),
					json,
					quiet,
				)
			}
			hostname = value
			continue
		}

		if (token === '--type') {
			const value = args[i + 1]
			if (!value || value.startsWith('--')) {
				return parseUsageError(
					'Missing value for --type',
					usageText(),
					json,
					quiet,
				)
			}
			typeFilter = value
			i++
			continue
		}

		if (token.startsWith('--type=')) {
			const value = token.slice('--type='.length)
			if (!value) {
				return parseUsageError(
					'Missing value for --type',
					usageText(),
					json,
					quiet,
				)
			}
			typeFilter = value
			continue
		}

		if (token === '--since') {
			const value = args[i + 1]
			if (!value || value.startsWith('--')) {
				return parseUsageError(
					'Missing value for --since',
					usageText(),
					json,
					quiet,
				)
			}
			since = value
			i++
			continue
		}

		if (token.startsWith('--since=')) {
			const value = token.slice('--since='.length)
			if (!value) {
				return parseUsageError(
					'Missing value for --since',
					usageText(),
					json,
					quiet,
				)
			}
			since = value
			continue
		}

		if (token === '--limit') {
			const value = args[i + 1]
			if (!value || value.startsWith('--')) {
				return parseUsageError(
					'Missing value for --limit',
					usageText(),
					json,
					quiet,
				)
			}
			limitRaw = value
			i++
			continue
		}

		if (token.startsWith('--limit=')) {
			const value = token.slice('--limit='.length)
			if (!value) {
				return parseUsageError(
					'Missing value for --limit',
					usageText(),
					json,
					quiet,
				)
			}
			limitRaw = value
			continue
		}

		if (token === '--fields') {
			const value = args[i + 1]
			if (!value || value.startsWith('--')) {
				return parseUsageError(
					'Missing value for --fields',
					usageText(),
					json,
					quiet,
				)
			}
			fieldsRaw = value
			i++
			continue
		}

		if (token.startsWith('--fields=')) {
			const value = token.slice('--fields='.length)
			if (!value) {
				return parseUsageError(
					'Missing value for --fields',
					usageText(),
					json,
					quiet,
				)
			}
			fieldsRaw = value
			continue
		}

		if (token.startsWith('-')) {
			return parseUsageError(
				`Unknown option: ${token}`,
				usageText(),
				json,
				quiet,
			)
		}

		if (commandToken === null) {
			commandToken = token
			continue
		}

		extraPositionals.push(token)
	}

	if (!commandToken) {
		return parseHelp(json, quiet)
	}

	if (commandToken === 'help') {
		const requestedTopic = extraPositionals[0]
		if (extraPositionals.length > 1) {
			return parseUsageError(
				`Unexpected argument: ${extraPositionals[1]}`,
				usageText(),
				json,
				quiet,
			)
		}

		if (!requestedTopic) {
			return parseHelp(json, quiet)
		}

		const topic = normalizeHelpTopic(requestedTopic)
		if (!topic) {
			return parseUsageError(
				`Unknown help topic: ${requestedTopic}`,
				usageText(),
				json,
				quiet,
			)
		}

		return parseHelp(json, quiet, topic)
	}

	if (extraPositionals.length > 0) {
		return parseUsageError(
			`Unexpected argument: ${extraPositionals[0]}`,
			usageText(),
			json,
			quiet,
		)
	}

	const normalizedCommand = commandToken === 'server' ? 'start' : commandToken

	if (!isCommand(normalizedCommand)) {
		return parseUsageError(
			`Unknown command: ${commandToken}`,
			usageText(),
			json,
			quiet,
		)
	}

	if (normalizedCommand !== 'start' && portRaw !== null) {
		return parseUsageError(
			'--port is only valid for the start/server command',
			usageText(),
			json,
			quiet,
		)
	}

	if (normalizedCommand !== 'start' && hostname !== DEFAULT_HOSTNAME) {
		return parseUsageError(
			'--host/--hostname is only valid for the start/server command',
			usageText(),
			json,
			quiet,
		)
	}

	const hasEventsOnlyFlags =
		jsonl ||
		typeFilter !== null ||
		since !== null ||
		limitRaw !== null ||
		fieldsRaw !== null
	if (normalizedCommand !== 'events' && hasEventsOnlyFlags) {
		return parseUsageError(
			'--jsonl/--type/--since/--limit/--fields are only valid for the events command',
			usageText(),
			json,
			quiet,
		)
	}

	if (normalizedCommand === 'start') {
		let portSource: PortSource = 'default'
		let rawPort = portRaw

		if (rawPort !== null) {
			portSource = 'arg'
		} else {
			const envPort = process.env.OBSERVABILITY_PORT ?? process.env.PORT
			if (envPort?.trim()) {
				rawPort = envPort.trim()
				portSource = 'env'
			}
		}

		const parsedPort = rawPort === null ? DEFAULT_PORT : parsePort(rawPort)
		if (parsedPort === null) {
			return parseUsageError(
				`Invalid port: ${String(rawPort)}`,
				usageText(),
				json,
				quiet,
			)
		}

		if (!hostname.trim()) {
			return parseUsageError('Host cannot be empty', usageText(), json, quiet)
		}

		return {
			ok: true,
			options: {
				command: 'start',
				port: parsedPort,
				hostname,
				portSource,
				json,
				quiet,
				nonInteractive,
			},
		}
	}

	if (normalizedCommand === 'status') {
		return {
			ok: true,
			options: {
				command: 'status',
				json,
				quiet,
				nonInteractive,
			},
		}
	}

	if (normalizedCommand === 'events') {
		if (json && jsonl) {
			return parseUsageError(
				'--json and --jsonl cannot be used together',
				usageText(),
				json,
				quiet,
			)
		}

		if (typeFilter !== null && !typeFilter.trim()) {
			return parseUsageError('--type cannot be empty', usageText(), json, quiet)
		}

		if (since !== null && Number.isNaN(Date.parse(since))) {
			return parseUsageError(
				`Invalid --since timestamp: ${since}`,
				usageText(),
				json,
				quiet,
			)
		}

		const limit = parseLimit(limitRaw)
		if (limitRaw !== null && limit === null) {
			return parseUsageError(
				`Invalid --limit value: ${limitRaw}`,
				usageText(),
				json,
				quiet,
			)
		}

		const fields = parseFields(fieldsRaw)
		if (fieldsRaw !== null && fields === null) {
			return parseUsageError(
				`Invalid --fields value: ${fieldsRaw}`,
				usageText(),
				json,
				quiet,
			)
		}

		return {
			ok: true,
			options: {
				command: 'events',
				json,
				quiet,
				nonInteractive,
				jsonl,
				typeFilter,
				since,
				limit,
				fields,
			},
		}
	}

	return {
		ok: true,
		options: {
			command: 'stop',
			json,
			quiet,
			nonInteractive,
		},
	}
}

/**
 * Run the observability CLI command.
 *
 * Why: Central command dispatcher keeps exit-code behavior consistent across
 * human and JSON modes while preserving a thin executable entrypoint.
 */
export async function runCli(argv = process.argv): Promise<ExitCode> {
	try {
		const parsed = parseCliArgs(argv)
		const autoMachineMode = shouldUseAutomaticMachineMode()

		if (!parsed.ok) {
			if (parsed.exitCode === EXIT_OK) {
				process.stdout.write(`${parsed.output}\n`)
				return EXIT_OK
			}

			if (parsed.json || autoMachineMode) {
				writeJsonError(parsed.message, parsed.errorCode)
			} else {
				process.stderr.write(`${parsed.output}\n`)
			}
			return parsed.exitCode
		}

		const options = applyAutomaticOutputMode(parsed.options, autoMachineMode)

		switch (options.command) {
			case 'start':
				return await runStart(options)
			case 'status':
				return await runStatus(options)
			case 'stop':
				return await runStop(options)
			case 'events':
				return await runEvents(options)
			default:
				writeError(
					options,
					'Unknown command',
					'E_USAGE',
					EXIT_USAGE,
					'UsageError',
				)
				return EXIT_USAGE
		}
	} catch (err) {
		if (isInterruptedError(err)) {
			writeJsonOrHumanRuntimeError(
				{ json: false, quiet: false },
				'Interrupted',
				EXIT_INTERRUPTED,
				'INTERRUPTED',
			)
			return EXIT_INTERRUPTED
		}

		const message = err instanceof Error ? err.message : String(err)
		writeJsonOrHumanRuntimeError(
			{ json: false, quiet: false },
			`Unexpected CLI failure: ${message}`,
			EXIT_RUNTIME,
			'E_RUNTIME',
		)
		return EXIT_RUNTIME
	}
}

function shouldUseAutomaticMachineMode(): boolean {
	return !isatty(1)
}

function applyAutomaticOutputMode(
	options: CliOptions,
	autoMachineMode: boolean,
): CliOptions {
	if (!autoMachineMode) return options

	// Auto machine mode: suppress prose in non-TTY pipelines.
	// JSONL is already machine-friendly, so it does not force --json.
	if (options.command === 'events' && options.jsonl) {
		return { ...options, quiet: true }
	}

	return { ...options, quiet: true, json: true }
}

async function runStart(options: StartCommand): Promise<ExitCode> {
	const existingPort = readEventServerPort()
	const requestedHost = displayHost(options.hostname)

	if (existingPort !== null) {
		if (options.portSource !== 'default' && options.port !== existingPort) {
			writeError(
				options,
				`A server is already running on port ${existingPort}. Requested port ${options.port} conflicts with the active instance.`,
				'E_CONFLICT',
				EXIT_CONFLICT,
				'ConflictError',
			)
			return EXIT_CONFLICT
		}

		const baseUrl = `http://${requestedHost}:${existingPort}`
		const discovery = readDiscoveryState()
		const data: StartSuccessData = {
			command: 'start',
			reusedExistingServer: true,
			pid: discovery.pid,
			port: existingPort,
			hostname: requestedHost,
			baseUrl,
			dashboardUrl: `${baseUrl}/`,
			healthUrl: `${baseUrl}/health`,
			eventsUrl: `${baseUrl}/events`,
			wsUrl: `${baseUrl.replace(/^http/, 'ws')}/ws`,
			portSource: options.portSource,
		}
		writeStartSuccess(options, data)
		return EXIT_OK
	}

	try {
		const server = startServer({
			appName: 'side-quest-observability',
			port: options.port,
			hostname: options.hostname,
			dashboardDistDir: join(import.meta.dir, '../public'),
		})

		const actualPort = server.port ?? options.port
		const baseUrl = `http://${requestedHost}:${actualPort}`
		const discovery = readDiscoveryState()
		const data: StartSuccessData = {
			command: 'start',
			reusedExistingServer: false,
			pid: discovery.pid,
			port: actualPort,
			hostname: requestedHost,
			baseUrl,
			dashboardUrl: `${baseUrl}/`,
			healthUrl: `${baseUrl}/health`,
			eventsUrl: `${baseUrl}/events`,
			wsUrl: `${baseUrl.replace(/^http/, 'ws')}/ws`,
			portSource: options.portSource,
		}
		writeStartSuccess(options, data)
		warnIfDashboardMissing(options)
		return EXIT_OK
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const lowerMessage = message.toLowerCase()
		if (
			message.includes('EADDRINUSE') ||
			message.includes('already listening') ||
			message.includes('already running') ||
			lowerMessage.includes('in use')
		) {
			writeError(
				options,
				`Failed to bind ${requestedHost}:${options.port}. Another process is already using this port.`,
				'E_CONFLICT',
				EXIT_CONFLICT,
				'ConflictError',
			)
			return EXIT_CONFLICT
		}

		if (message.includes('EACCES') || message.includes('EPERM')) {
			writeError(
				options,
				`Not permitted to bind ${requestedHost}:${options.port}.`,
				'E_UNAUTHORIZED',
				EXIT_UNAUTHORIZED,
				'PermissionError',
			)
			return EXIT_UNAUTHORIZED
		}

		writeError(
			options,
			`Failed to start server: ${message}`,
			'E_RUNTIME',
			EXIT_RUNTIME,
			'RuntimeError',
		)
		return EXIT_RUNTIME
	}
}

async function runStatus(options: StatusCommand): Promise<ExitCode> {
	const port = readEventServerPort()
	if (port === null) {
		writeError(
			options,
			'No running observability server found.',
			'E_NOT_FOUND',
			EXIT_NOT_FOUND,
			'NotFoundError',
		)
		return EXIT_NOT_FOUND
	}

	const baseUrl = `http://127.0.0.1:${port}`

	try {
		const health = await fetchJsonWithTimeout(`${baseUrl}/health`, 1_500)
		const discovery = readDiscoveryState()
		const data: StatusSuccessData = {
			command: 'status',
			running: true,
			pid: discovery.pid,
			port,
			baseUrl,
			health,
		}
		writeStatusSuccess(options, data)
		return EXIT_OK
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		writeError(
			options,
			`Server discovered on port ${port}, but health check failed: ${message}`,
			'E_RUNTIME',
			EXIT_RUNTIME,
			'RuntimeError',
		)
		return EXIT_RUNTIME
	}
}

async function runStop(options: StopCommand): Promise<ExitCode> {
	const discovery = readDiscoveryState()
	const port = readEventServerPort()
	const pid = discovery.pid

	if (port === null || pid === null || !isProcessRunning(pid)) {
		cleanupDiscoveryFiles()
		writeError(
			options,
			'No running observability server found.',
			'E_NOT_FOUND',
			EXIT_NOT_FOUND,
			'NotFoundError',
		)
		return EXIT_NOT_FOUND
	}

	try {
		process.kill(pid, 'SIGTERM')
	} catch (err) {
		const code = getNodeErrorCode(err)
		if (code === 'ESRCH') {
			cleanupDiscoveryFiles()
			const data: StopSuccessData = {
				command: 'stop',
				stopped: true,
				pid,
				port,
			}
			writeStopSuccess(options, data)
			return EXIT_OK
		}

		if (code === 'EPERM' || code === 'EACCES') {
			writeError(
				options,
				`Not permitted to stop process ${pid}.`,
				'E_UNAUTHORIZED',
				EXIT_UNAUTHORIZED,
				'PermissionError',
			)
			return EXIT_UNAUTHORIZED
		}

		const message = err instanceof Error ? err.message : String(err)
		writeError(
			options,
			`Failed to stop process ${pid}: ${message}`,
			'E_RUNTIME',
			EXIT_RUNTIME,
			'RuntimeError',
		)
		return EXIT_RUNTIME
	}

	const stopped = await waitForExit(pid, STOP_TIMEOUT_MS)
	if (!stopped) {
		writeError(
			options,
			`Timed out waiting for process ${pid} to stop.`,
			'E_RUNTIME',
			EXIT_RUNTIME,
			'RuntimeError',
		)
		return EXIT_RUNTIME
	}

	cleanupDiscoveryFiles()
	const data: StopSuccessData = {
		command: 'stop',
		stopped: true,
		pid,
		port,
	}
	writeStopSuccess(options, data)
	return EXIT_OK
}

async function runEvents(options: EventsCommand): Promise<ExitCode> {
	const port = readEventServerPort()
	if (port === null) {
		writeError(
			options,
			'No running observability server found.',
			'E_NOT_FOUND',
			EXIT_NOT_FOUND,
			'NotFoundError',
		)
		return EXIT_NOT_FOUND
	}

	const url = new URL(`http://127.0.0.1:${port}/events`)
	if (options.typeFilter) {
		url.searchParams.set('type', options.typeFilter)
	}
	if (options.since) {
		url.searchParams.set('since', options.since)
	}
	if (options.limit !== null) {
		url.searchParams.set('limit', String(options.limit))
	}

	try {
		const payload = await fetchJsonWithTimeout(url.toString(), 2_000)
		if (!Array.isArray(payload)) {
			writeError(
				options,
				'Invalid /events response: expected array payload.',
				'E_RUNTIME',
				EXIT_RUNTIME,
				'RuntimeError',
			)
			return EXIT_RUNTIME
		}

		const events =
			options.fields && options.fields.length > 0
				? payload.map((event) => projectFields(event, options.fields ?? []))
				: payload

		if (options.jsonl) {
			for (const event of events) {
				process.stdout.write(`${JSON.stringify(event)}\n`)
			}
			return EXIT_OK
		}

		const data: EventsSuccessData = {
			command: 'events',
			count: events.length,
			events,
			filters: {
				type: options.typeFilter,
				since: options.since,
				limit: options.limit,
				fields: options.fields,
			},
		}
		writeEventsSuccess(options, data)
		return EXIT_OK
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const httpCode = parseHttpStatus(message)

		if (httpCode === 401 || httpCode === 403) {
			writeError(
				options,
				`Unauthorized while reading events (HTTP ${httpCode}).`,
				'E_UNAUTHORIZED',
				EXIT_UNAUTHORIZED,
				'PermissionError',
			)
			return EXIT_UNAUTHORIZED
		}

		if (httpCode === 404) {
			writeError(
				options,
				'Events endpoint not found on running server.',
				'E_NOT_FOUND',
				EXIT_NOT_FOUND,
				'NotFoundError',
			)
			return EXIT_NOT_FOUND
		}

		writeError(
			options,
			`Failed to fetch events: ${message}`,
			'E_RUNTIME',
			EXIT_RUNTIME,
			'RuntimeError',
		)
		return EXIT_RUNTIME
	}
}

function parseHelp(
	json: boolean,
	quiet: boolean,
	topic: HelpTopic = 'overview',
): ParseCliError {
	return {
		ok: false,
		exitCode: EXIT_OK,
		message: 'Help requested',
		output: helpText(topic),
		errorCode: 'E_HELP',
		json,
		quiet,
	}
}

function parseUsageError(
	message: string,
	usage: string,
	json: boolean,
	quiet: boolean,
): ParseCliError {
	return {
		ok: false,
		exitCode: EXIT_USAGE,
		message,
		output: `${message}\n\n${usage}`,
		errorCode: 'E_USAGE',
		json,
		quiet,
	}
}

function usageText(): string {
	return [
		'Observability CLI',
		'',
		'Usage:',
		'  observability <command> [command options] [global options]',
		'  observability help [topic]',
		'',
		'Command summary:',
		'  start, server           Start the observability server',
		'  status                  Show server health and process status',
		'  stop                    Stop the running server',
		'  events                  List stored events',
		'  help [topic]            Show topic help',
		'',
		'Global options:',
		'  --json                  Output machine-readable JSON',
		'  --quiet                 Suppress verbose human output',
		'  --non-interactive       Disable prompts (fail fast)',
		'  -h, --help              Show this help',
		'',
		'start/server options:',
		'  --port <PORT>           Listen port (0-65535, default: 7483)',
		'  --host, --hostname      Bind host (default: 127.0.0.1)',
		'',
		'events options:',
		'  --jsonl                 Output newline-delimited JSON rows',
		'  --type <TYPE>           Filter by event type',
		'  --since <ISO>           Filter events after ISO timestamp',
		'  --limit <N>             Max rows to return (1-1000)',
		'  --fields <A,B,C>        Select specific top-level/dot fields',
		'',
		'CLI output contract (agent mode):',
		'  Success (stdout): {"status":"data","data":{...}}',
		'  Error   (stderr): {"status":"error","message":"...","error":{"name":"...","code":"..."}}',
		'',
		'HTTP server API:',
		'  GET    /health                     Health + diagnostics',
		'  GET    /events?type&since&limit    Query buffered events',
		'  POST   /events                      Send pre-built EventEnvelope or {type,data,...}',
		'  POST   /events/:eventName           Hook ingress (raw hook payload)',
		'  POST   /voice/notify                Voice playback trigger',
		'  WS     /ws                          Real-time stream (?type=<eventType>)',
		'  GET    /                            Dashboard SPA (if assets present)',
		'',
		'Event envelope shape (stored/streamed):',
		'  {"schemaVersion":"1.0.0","id":"...","timestamp":"...","type":"...","app":"...","appRoot":"...","source":"cli|hook","correlationId":"...","data":{...}}',
		'',
		'Environment:',
		'  OBSERVABILITY_PORT      Default port when --port is omitted',
		'  PORT                    Fallback default port when OBSERVABILITY_PORT is unset',
		'',
		'Exit codes:',
		'  0 success, 1 runtime, 2 usage, 3 not found, 4 unauthorized, 5 conflict, 130 interrupted',
		'',
		'Human examples:',
		'  bunx @side-quest/observability-server start --port 7512',
		'  bunx @side-quest/observability-server events --limit 20',
		'',
		'Agent examples:',
		'  bunx @side-quest/observability-server status --json',
		'  bunx @side-quest/observability-server events --jsonl --limit 50',
		'  bunx @side-quest/observability-server events --json --fields id,type,data.hookEvent --limit 100',
		'  bunx @side-quest/observability-server stop --json --quiet',
		'',
		'Help topics:',
		'  overview, start, status, stop, events, api, contract',
		'  Example: observability help api',
	].join('\n')
}

function helpText(topic: HelpTopic): string {
	switch (topic) {
		case 'overview':
			return usageText()
		case 'start':
			return [
				'Help: start',
				'',
				'Usage:',
				'  observability start [--port <PORT>] [--host <HOST>] [--json] [--quiet]',
				'  observability server [same options]',
				'',
				'Behavior:',
				'  Starts the local observability server.',
				'  If a compatible server is already running, returns that instance.',
				'  Dashboard/API/WebSocket URLs are returned in output.',
				'',
				'Examples:',
				'  observability start --port 7512',
				'  observability server --json',
			].join('\n')
		case 'status':
			return [
				'Help: status',
				'',
				'Usage:',
				'  observability status [--json] [--quiet]',
				'',
				'Behavior:',
				'  Reads discovery files, checks server health, and returns runtime diagnostics.',
				'  Exit code 3 when no server is running.',
				'',
				'Examples:',
				'  observability status',
				'  observability status --json',
			].join('\n')
		case 'stop':
			return [
				'Help: stop',
				'',
				'Usage:',
				'  observability stop [--json] [--quiet]',
				'',
				'Behavior:',
				'  Sends SIGTERM to the discovered server PID and waits for shutdown.',
				'  Removes stale discovery files when process is already gone.',
				'',
				'Examples:',
				'  observability stop',
				'  observability stop --json --quiet',
			].join('\n')
		case 'events':
			return [
				'Help: events',
				'',
				'Usage:',
				'  observability events [--type <TYPE>] [--since <ISO>] [--limit <N>]',
				'                       [--fields <A,B,C>] [--json | --jsonl] [--quiet]',
				'',
				'Options:',
				'  --type <TYPE>           Filter by event type (e.g. hook.stop)',
				'  --since <ISO>           ISO timestamp lower bound',
				'  --limit <N>             Max rows (1-1000)',
				'  --fields <A,B,C>        Field projection, dot-path supported',
				'  --json                  Wrapped contract output',
				'  --jsonl                 One event JSON object per line',
				'',
				'Examples:',
				'  observability events --limit 20',
				'  observability events --jsonl --type hook.stop --limit 100',
				'  observability events --json --fields id,type,data.hookEvent --limit 50',
			].join('\n')
		case 'api':
			return [
				'Help: api',
				'',
				'HTTP routes:',
				'  GET    /health                     Health + diagnostics',
				'  GET    /events?type&since&limit    Query buffered events',
				'  POST   /events                      Submit envelope or {type,data,...}',
				'  POST   /events/:eventName           Hook ingress',
				'  POST   /voice/notify                Voice trigger',
				'  WS     /ws                          Live stream (?type=<eventType>)',
				'  GET    /                            Dashboard SPA',
				'',
				'Envelope shape:',
				'  {"schemaVersion":"1.0.0","id":"...","timestamp":"...","type":"...","app":"...","appRoot":"...","source":"cli|hook","correlationId":"...","data":{...}}',
				'',
				'Quick check:',
				'  curl http://127.0.0.1:7483/health',
				'  curl http://127.0.0.1:7483/events?limit=10',
			].join('\n')
		case 'contract':
			return [
				'Help: contract',
				'',
				'CLI machine contract:',
				'  Success to stdout:',
				'    {"status":"data","data":{...}}',
				'  Error to stderr:',
				'    {"status":"error","message":"...","error":{"name":"...","code":"..."}}',
				'',
				'Exit codes:',
				'  0 success',
				'  1 runtime error',
				'  2 usage/argument error',
				'  3 not found',
				'  4 unauthorized',
				'  5 conflict',
				'  130 interrupted',
				'',
				'Non-TTY behavior:',
				'  Automatically emits machine-friendly output when stdout is not a TTY.',
			].join('\n')
	}
}

function normalizeHelpTopic(raw: string): HelpTopic | null {
	const value = raw.trim().toLowerCase()

	switch (value) {
		case '':
			return 'overview'
		case 'overview':
		case 'usage':
		case 'all':
			return 'overview'
		case 'start':
		case 'server':
			return 'start'
		case 'status':
			return 'status'
		case 'stop':
			return 'stop'
		case 'events':
			return 'events'
		case 'api':
		case 'http':
		case 'routes':
			return 'api'
		case 'contract':
		case 'output':
		case 'json':
			return 'contract'
		default:
			return null
	}
}

function parsePort(raw: string): number | null {
	if (!/^\d+$/.test(raw)) return null
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
		return null
	}
	return parsed
}

function parseLimit(raw: string | null): number | null {
	if (raw === null) return null
	if (!/^\d+$/.test(raw)) return null
	const parsed = Number.parseInt(raw, 10)
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
		return null
	}
	return parsed
}

function parseFields(raw: string | null): readonly string[] | null {
	if (raw === null) return null
	const parsed = raw
		.split(',')
		.map((field) => field.trim())
		.filter((field) => field.length > 0)

	if (parsed.length === 0) return null
	if (parsed.some((field) => !/^[A-Za-z0-9_.-]+$/.test(field))) {
		return null
	}
	return parsed
}

function isCommand(value: string): value is CommandName {
	return (
		value === 'start' ||
		value === 'status' ||
		value === 'stop' ||
		value === 'events'
	)
}

function readDiscoveryState(): DiscoveryState {
	return {
		pid: readIntFile(PID_FILE),
		port: readIntFile(PORT_FILE),
		nonce: readTextFile(NONCE_FILE),
	}
}

function readIntFile(filePath: string): number | null {
	try {
		const value = readFileSync(filePath, 'utf8').trim()
		if (!/^\d+$/.test(value)) return null
		const parsed = Number.parseInt(value, 10)
		return Number.isInteger(parsed) && parsed > 0 ? parsed : null
	} catch {
		return null
	}
}

function readTextFile(filePath: string): string | null {
	try {
		const value = readFileSync(filePath, 'utf8').trim()
		return value.length > 0 ? value : null
	} catch {
		return null
	}
}

function cleanupDiscoveryFiles(): void {
	for (const file of [PID_FILE, PORT_FILE, NONCE_FILE]) {
		try {
			unlinkSync(file)
		} catch {
			// Best-effort cleanup
		}
	}
}

function isProcessRunning(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs

	while (Date.now() < deadline) {
		if (!isProcessRunning(pid)) {
			return true
		}
		await Bun.sleep(100)
	}

	return !isProcessRunning(pid)
}

async function fetchJsonWithTimeout(
	url: string,
	timeoutMs: number,
): Promise<unknown> {
	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), timeoutMs)
	try {
		const res = await fetch(url, { signal: controller.signal })
		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`)
		}
		return await res.json()
	} finally {
		clearTimeout(timeout)
	}
}

function writeStartSuccess(ctx: OutputContext, data: StartSuccessData): void {
	writeSuccess(
		ctx,
		data,
		data.reusedExistingServer
			? [
					`[observability] Server already running: ${data.baseUrl}`,
					`[observability] Dashboard: ${data.dashboardUrl}`,
					`[observability] Health:    ${data.healthUrl}`,
				]
			: [
					`[observability] Server running at ${data.baseUrl}`,
					`[observability] Dashboard: ${data.dashboardUrl}`,
					`[observability] Health:    ${data.healthUrl}`,
					`[observability] Events:    ${data.eventsUrl}`,
					`[observability] WebSocket: ${data.wsUrl}`,
					'[observability] Stop with Ctrl+C',
				],
		data.baseUrl,
	)
}

function writeStatusSuccess(ctx: OutputContext, data: StatusSuccessData): void {
	const healthSummary =
		data.health && typeof data.health === 'object'
			? JSON.stringify(data.health)
			: String(data.health)
	writeSuccess(
		ctx,
		data,
		[
			`[observability] Running: yes`,
			`[observability] PID:     ${data.pid ?? 'unknown'}`,
			`[observability] Base:    ${data.baseUrl}`,
			`[observability] Health:  ${healthSummary}`,
		],
		data.baseUrl,
	)
}

function writeEventsSuccess(ctx: OutputContext, data: EventsSuccessData): void {
	const previewLimit = 20
	const previewEvents = data.events.slice(0, previewLimit)
	const lines: string[] = [`[observability] Events: ${data.count}`]

	for (const event of previewEvents) {
		lines.push(formatEventLine(event))
	}

	if (data.count > previewLimit) {
		lines.push(
			`[observability] ... ${data.count - previewLimit} additional events omitted`,
		)
	}

	writeSuccess(ctx, data, lines, `events:${data.count}`)
}

function writeStopSuccess(ctx: OutputContext, data: StopSuccessData): void {
	writeSuccess(
		ctx,
		data,
		[`[observability] Stopped server PID ${data.pid} on port ${data.port}.`],
		`stopped:${data.pid}`,
	)
}

function writeSuccess<T>(
	ctx: OutputContext,
	data: T,
	humanLines: string[],
	quietLine: string,
): void {
	if (ctx.json) {
		process.stdout.write(`${JSON.stringify({ status: 'data', data })}\n`)
		return
	}

	if (ctx.quiet) {
		process.stdout.write(`${quietLine}\n`)
		return
	}

	process.stdout.write(`${humanLines.join('\n')}\n`)
}

function writeError(
	ctx: OutputContext,
	message: string,
	errorCode: string,
	_exitCode: ExitCode,
	errorName: string,
): void {
	if (ctx.json) {
		writeJsonError(message, errorCode, errorName)
		return
	}

	const line = ctx.quiet ? message : `[observability] ${message}`
	process.stderr.write(`${line}\n`)
}

function writeJsonError(
	message: string,
	code: string,
	name = 'CliError',
): void {
	const payload: JsonErrorBody = {
		status: 'error',
		message,
		error: {
			name,
			code,
		},
	}
	process.stderr.write(`${JSON.stringify(payload)}\n`)
}

function writeJsonOrHumanRuntimeError(
	ctx: OutputContext,
	message: string,
	_exitCode: ExitCode,
	code: string,
): void {
	if (ctx.json) {
		writeJsonError(message, code, 'RuntimeError')
		return
	}
	process.stderr.write(`[observability] ${message}\n`)
}

function warnIfDashboardMissing(ctx: OutputContext): void {
	if (ctx.quiet) return

	const candidates = [
		join(import.meta.dir, '../public/index.html'),
		join(import.meta.dir, '../../client/dist/index.html'),
	]

	const found = candidates.some((candidate) => existsSync(candidate))
	if (!found) {
		process.stderr.write(
			`[observability] Warning: dashboard assets were not found at ${candidates.join(
				' or ',
			)}.\n`,
		)
	}
}

function formatEventLine(event: unknown): string {
	if (!event || typeof event !== 'object' || Array.isArray(event)) {
		return `[observability] ${JSON.stringify(event)}`
	}

	const value = event as Record<string, unknown>
	const timestamp =
		typeof value.timestamp === 'string' ? value.timestamp : 'unknown-time'
	const type = typeof value.type === 'string' ? value.type : 'unknown-type'
	const id = typeof value.id === 'string' ? value.id : 'unknown-id'
	return `[observability] ${timestamp}  ${type}  ${id}`
}

function projectFields(
	value: unknown,
	fields: readonly string[],
): Record<string, unknown> {
	const projected: Record<string, unknown> = {}
	for (const field of fields) {
		projected[field] = readPath(value, field)
	}
	return projected
}

function readPath(value: unknown, field: string): unknown {
	const segments = field.split('.').filter((segment) => segment.length > 0)
	let cursor: unknown = value
	for (const segment of segments) {
		if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
			return undefined
		}
		cursor = (cursor as Record<string, unknown>)[segment]
	}
	return cursor
}

function parseHttpStatus(message: string): number | null {
	const match = message.match(/HTTP\s+(\d{3})/i)
	if (!match?.[1]) return null
	const status = Number.parseInt(match[1], 10)
	return Number.isInteger(status) ? status : null
}

function displayHost(hostname: string): string {
	if (hostname === '0.0.0.0') return '127.0.0.1'
	if (hostname === '::') return '[::1]'
	if (hostname.includes(':') && !hostname.startsWith('[')) {
		return `[${hostname}]`
	}
	return hostname
}

function getNodeErrorCode(err: unknown): string | null {
	if (!err || typeof err !== 'object') return null
	const maybeCode = (err as { code?: unknown }).code
	return typeof maybeCode === 'string' ? maybeCode : null
}

function isInterruptedError(err: unknown): boolean {
	const code = getNodeErrorCode(err)
	return code === 'SIGINT' || code === 'ABORT_ERR'
}

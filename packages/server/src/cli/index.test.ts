import { describe, expect, test } from 'bun:test'
import { parseCliArgs } from './command.js'

const baseArgv = ['bun', 'observability']

describe('parseCliArgs', () => {
	test('returns help output when no command is provided', () => {
		const parsed = parseCliArgs(baseArgv)
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(0)
		expect(parsed.output).toContain('Usage:')
		expect(parsed.output).toContain('CLI output contract')
		expect(parsed.output).toContain('HTTP server API')
	})

	test('returns topic help for `help <topic>`', () => {
		const parsed = parseCliArgs([...baseArgv, 'help', 'api'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(0)
		expect(parsed.output).toContain('Help: api')
		expect(parsed.output).toContain('HTTP routes:')
	})

	test('returns command-scoped help for `events --help`', () => {
		const parsed = parseCliArgs([...baseArgv, 'events', '--help'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(0)
		expect(parsed.output).toContain('Help: events')
		expect(parsed.output).toContain('--jsonl')
	})

	test('returns error for unknown help topic', () => {
		const parsed = parseCliArgs([...baseArgv, 'help', 'wat'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Unknown help topic')
	})

	test('parses server alias as start command', () => {
		const parsed = parseCliArgs([...baseArgv, 'server'])
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return

		expect(parsed.options.command).toBe('start')
		expect(parsed.options.port).toBe(7483)
		expect(parsed.options.hostname).toBe('127.0.0.1')
		expect(parsed.options.portSource).toBe('default')
	})

	test('parses start command with --port and --host flags', () => {
		const parsed = parseCliArgs([...baseArgv, 'start', '--port', '7512', '--host', '0.0.0.0'])
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return

		expect(parsed.options.command).toBe('start')
		expect(parsed.options.port).toBe(7512)
		expect(parsed.options.hostname).toBe('0.0.0.0')
		expect(parsed.options.portSource).toBe('arg')
	})

	test('parses --port=<value> form', () => {
		const parsed = parseCliArgs([...baseArgv, 'start', '--port=0'])
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return

		expect(parsed.options.command).toBe('start')
		expect(parsed.options.port).toBe(0)
		expect(parsed.options.portSource).toBe('arg')
	})

	test('parses global flags before command', () => {
		const parsed = parseCliArgs([...baseArgv, '--json', '--quiet', '--non-interactive', 'status'])
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return

		expect(parsed.options.command).toBe('status')
		expect(parsed.options.json).toBe(true)
		expect(parsed.options.quiet).toBe(true)
		expect(parsed.options.nonInteractive).toBe(true)
	})

	test('parses stop command', () => {
		const parsed = parseCliArgs([...baseArgv, 'stop', '--json'])
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return

		expect(parsed.options.command).toBe('stop')
		expect(parsed.options.json).toBe(true)
	})

	test('parses events command with query flags and jsonl', () => {
		const parsed = parseCliArgs([
			...baseArgv,
			'events',
			'--jsonl',
			'--type',
			'hook.stop',
			'--since',
			'2026-02-18T00:00:00Z',
			'--limit',
			'25',
			'--fields',
			'id,type,data.hookEvent',
		])
		expect(parsed.ok).toBe(true)
		if (!parsed.ok) return

		expect(parsed.options.command).toBe('events')
		expect(parsed.options.jsonl).toBe(true)
		expect(parsed.options.typeFilter).toBe('hook.stop')
		expect(parsed.options.since).toBe('2026-02-18T00:00:00Z')
		expect(parsed.options.limit).toBe(25)
		expect(parsed.options.fields).toEqual(['id', 'type', 'data.hookEvent'])
	})

	test('uses OBSERVABILITY_PORT env var when --port is omitted', () => {
		const previousObs = process.env.OBSERVABILITY_PORT
		const previousPort = process.env.PORT
		process.env.OBSERVABILITY_PORT = '7520'
		process.env.PORT = '9000'

		try {
			const parsed = parseCliArgs([...baseArgv, 'start'])
			expect(parsed.ok).toBe(true)
			if (!parsed.ok) return

			expect(parsed.options.command).toBe('start')
			expect(parsed.options.port).toBe(7520)
			expect(parsed.options.portSource).toBe('env')
		} finally {
			if (previousObs === undefined) delete process.env.OBSERVABILITY_PORT
			else process.env.OBSERVABILITY_PORT = previousObs

			if (previousPort === undefined) delete process.env.PORT
			else process.env.PORT = previousPort
		}
	})

	test('returns error for invalid port values', () => {
		const parsed = parseCliArgs([...baseArgv, 'start', '--port', 'abc'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Invalid port')
		expect(parsed.errorCode).toBe('E_USAGE')
	})

	test('returns error for missing --port value', () => {
		const parsed = parseCliArgs([...baseArgv, 'start', '--port'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Missing value for --port')
	})

	test('returns error for unknown options', () => {
		const parsed = parseCliArgs([...baseArgv, 'start', '--wat'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Unknown option')
	})

	test('returns error for unknown commands', () => {
		const parsed = parseCliArgs([...baseArgv, 'wat'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Unknown command')
	})

	test('returns error when start-only flags are used with status', () => {
		const parsed = parseCliArgs([...baseArgv, 'status', '--port', '7512'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('only valid for the start/server command')
	})

	test('returns error when events-only flags are used with start', () => {
		const parsed = parseCliArgs([...baseArgv, 'start', '--jsonl'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('only valid for the events command')
	})

	test('returns error when --json and --jsonl are both set', () => {
		const parsed = parseCliArgs([...baseArgv, 'events', '--json', '--jsonl'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('cannot be used together')
	})

	test('returns error for invalid --limit values', () => {
		const parsed = parseCliArgs([...baseArgv, 'events', '--limit', '0'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Invalid --limit value')
	})

	test('returns error for invalid --since values', () => {
		const parsed = parseCliArgs([...baseArgv, 'events', '--since', 'not-a-date'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Invalid --since timestamp')
	})

	test('returns error for invalid --fields values', () => {
		const parsed = parseCliArgs([...baseArgv, 'events', '--fields', 'id,type,?bad'])
		expect(parsed.ok).toBe(false)
		if (parsed.ok) return

		expect(parsed.exitCode).toBe(2)
		expect(parsed.output).toContain('Invalid --fields value')
	})
})

import { describe, expect, test } from 'bun:test'
import { connectEventClient } from './client.js'

interface FakeWebSocketInstance {
	readonly url: string
	onopen: ((event: Event) => void) | null
	onmessage: ((event: MessageEvent) => void) | null
	onclose: ((event: CloseEvent) => void) | null
	onerror: ((event: Event) => void) | null
	close(code?: number, reason?: string): void
	emitOpen(): void
	emitClose(): void
}

class FakeWebSocket implements FakeWebSocketInstance {
	static instances: FakeWebSocket[] = []

	readonly url: string
	onopen: ((event: Event) => void) | null = null
	onmessage: ((event: MessageEvent) => void) | null = null
	onclose: ((event: CloseEvent) => void) | null = null
	onerror: ((event: Event) => void) | null = null

	constructor(url: string) {
		this.url = url
		FakeWebSocket.instances.push(this)
	}

	close(_code?: number, _reason?: string): void {
		this.emitClose()
	}

	emitOpen(): void {
		this.onopen?.({ type: 'open' } as Event)
	}

	emitClose(): void {
		this.onclose?.({ type: 'close' } as CloseEvent)
	}
}

function installWebSocketTestHarness(options?: { random?: number }): {
	readonly delays: number[]
	restore: () => void
} {
	const originalWebSocket = globalThis.WebSocket
	const originalSetTimeout = globalThis.setTimeout
	const originalClearTimeout = globalThis.clearTimeout
	const originalRandom = Math.random

	FakeWebSocket.instances = []

	const delays: number[] = []
	let timerId = 0

	globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
	globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
		delays.push(Number(timeout ?? 0))
		if (typeof handler === 'function') {
			handler()
		}
		timerId++
		return timerId as unknown as ReturnType<typeof setTimeout>
	}) as typeof setTimeout
	globalThis.clearTimeout = (() => undefined) as typeof clearTimeout
	Math.random = () => options?.random ?? 0

	return {
		delays,
		restore: () => {
			globalThis.WebSocket = originalWebSocket
			globalThis.setTimeout = originalSetTimeout
			globalThis.clearTimeout = originalClearTimeout
			Math.random = originalRandom
		},
	}
}

describe('connectEventClient', () => {
	test('reconnect delay grows exponentially and caps at 30s', () => {
		const { delays, restore } = installWebSocketTestHarness()

		try {
			const handle = connectEventClient({
				port: 7483,
				onEvent: () => undefined,
				reconnectDelay: 1000,
			})

			FakeWebSocket.instances[0]?.emitClose()
			FakeWebSocket.instances[1]?.emitClose()
			FakeWebSocket.instances[2]?.emitClose()
			FakeWebSocket.instances[3]?.emitClose()
			FakeWebSocket.instances[4]?.emitClose()
			FakeWebSocket.instances[5]?.emitClose()

			expect(delays.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000])
			handle.close()
		} finally {
			restore()
		}
	})

	test('adds jitter to reconnect delay', () => {
		const { delays, restore } = installWebSocketTestHarness({ random: 0.5 })

		try {
			const handle = connectEventClient({
				port: 7483,
				onEvent: () => undefined,
				reconnectDelay: 1000,
			})

			FakeWebSocket.instances[0]?.emitClose()
			expect(delays[0]).toBe(1500)
			handle.close()
		} finally {
			restore()
		}
	})

	test('resets reconnect attempt after a successful open', () => {
		const { delays, restore } = installWebSocketTestHarness({ random: 0 })

		try {
			const handle = connectEventClient({
				port: 7483,
				onEvent: () => undefined,
				reconnectDelay: 1000,
			})

			FakeWebSocket.instances[0]?.emitClose()
			FakeWebSocket.instances[1]?.emitOpen()
			FakeWebSocket.instances[1]?.emitClose()

			expect(delays.slice(0, 2)).toEqual([1000, 1000])
			handle.close()
		} finally {
			restore()
		}
	})
})

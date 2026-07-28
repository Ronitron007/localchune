// src/lib/upload-queue.test.ts
// localchune — MIT licensed. See LICENSE.
// NOTE: the distributed combination is AGPL-3.0 because the analysis
// worker includes Essentia. LICENSE explains why.

import { describe, it, expect } from 'vitest'
import {
  pump, FILE_CONCURRENCY, PART_CONCURRENCY, PREFLIGHT_CONCURRENCY,
  type PumpTask,
} from './upload-queue'

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('pump', () => {
  it('runs every task and returns results in input order', async () => {
    const delays = [30, 0, 15, 5]
    const tasks: PumpTask<number>[] = delays.map((ms, i) => async () => {
      await new Promise((r) => setTimeout(r, ms))
      return i
    })
    const results = await pump(tasks, { concurrency: 2 })
    expect(results.map((r) => r.index)).toEqual([0, 1, 2, 3])
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([0, 1, 2, 3])
  })

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const tasks: PumpTask<number>[] = Array.from({ length: 20 }, (_, i) => async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await tick()
      inFlight -= 1
      return i
    })
    const results = await pump(tasks, { concurrency: 3 })
    expect(peak).toBe(3)
    expect(results).toHaveLength(20)
  })

  it('pulls from the iterator lazily rather than materialising every task', async () => {
    // This is the "200 files must not open 200 sockets" property, asserted.
    let produced = 0
    const gate = deferred<void>()
    function* generate(): Generator<PumpTask<number>> {
      for (let i = 0; i < 200; i += 1) {
        produced += 1
        yield async () => { await gate.promise; return i }
      }
    }
    const run = pump(generate(), { concurrency: 3 })
    await tick()
    expect(produced).toBe(3)
    gate.resolve()
    await run
    expect(produced).toBe(200)
  })

  it('a rejected task does not stop the batch', async () => {
    const tasks: PumpTask<string>[] = [
      async () => 'a',
      async () => { throw new Error('boom') },
      async () => 'c',
    ]
    const results = await pump(tasks, { concurrency: 2 })
    expect(results[0]).toEqual({ index: 0, status: 'fulfilled', value: 'a' })
    expect(results[1].status).toBe('rejected')
    expect(results[2]).toEqual({ index: 2, status: 'fulfilled', value: 'c' })
  })

  it('never rejects, even when every task throws', async () => {
    const tasks: PumpTask<never>[] = Array.from({ length: 5 }, () => async () => {
      throw new Error('nope')
    })
    const results = await pump(tasks, { concurrency: 2 })
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
  })

  it('aborts running tasks and skips the ones that had not started', async () => {
    const controller = new AbortController()
    const started: number[] = []
    const abortSeen: number[] = []
    const gate = deferred<void>()
    const tasks: PumpTask<string>[] = Array.from({ length: 6 }, (_, i) => async (signal) => {
      started.push(i)
      signal.addEventListener('abort', () => abortSeen.push(i), { once: true })
      await gate.promise
      return `done-${i}`
    })

    const run = pump(tasks, { concurrency: 2, signal: controller.signal })
    await tick()
    expect(started).toEqual([0, 1])

    controller.abort(new Error('user cancelled'))
    gate.resolve()
    const results = await run

    expect([...abortSeen].sort()).toEqual([0, 1])
    expect(started).toEqual([0, 1])
    expect(results[0]).toEqual({ index: 0, status: 'fulfilled', value: 'done-0' })
    expect(results.slice(2).every((r) => r.status === 'skipped')).toBe(true)
  })

  it('skips everything when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('too late'))
    let ran = 0
    const tasks: PumpTask<number>[] = Array.from({ length: 4 }, () => async () => {
      ran += 1
      return 1
    })
    const results = await pump(tasks, { concurrency: 2, signal: controller.signal })
    expect(ran).toBe(0)
    expect(results.every((r) => r.status === 'skipped')).toBe(true)
  })

  it('calls onSettled once per task, in completion order', async () => {
    const order: number[] = []
    const delays = [30, 5, 15]
    const tasks: PumpTask<number>[] = delays.map((ms, i) => async () => {
      await new Promise((r) => setTimeout(r, ms))
      return i
    })
    await pump(tasks, { concurrency: 3, onSettled: (r) => order.push(r.index) })
    expect(order).toEqual([1, 2, 0])
  })

  it('returns an empty array for an empty input', async () => {
    expect(await pump([], { concurrency: 3 })).toEqual([])
  })

  it('tolerates a concurrency larger than the task count', async () => {
    const tasks: PumpTask<number>[] = [async () => 1, async () => 2]
    const results = await pump(tasks, { concurrency: 50 })
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([1, 2])
  })

  it('refuses a non-positive concurrency', async () => {
    await expect(pump([], { concurrency: 0 })).rejects.toThrow('positive integer')
    await expect(pump([], { concurrency: 1.5 })).rejects.toThrow('positive integer')
  })
})

describe('concurrency constants', () => {
  it('keeps the worst case in-flight PUT count at nine or fewer', () => {
    expect(FILE_CONCURRENCY).toBe(3)
    expect(PART_CONCURRENCY).toBe(3)
    expect(PREFLIGHT_CONCURRENCY).toBe(4)
    expect(FILE_CONCURRENCY * PART_CONCURRENCY).toBeLessThanOrEqual(9)
  })
})

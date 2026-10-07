/**
 * The wait vocabulary's own behaviour (D12(b)).
 *
 * **Not one test here waits on a duration** — which is the rule this module is about. Time
 * is an injected counter and the delay is a recording stub that resolves immediately, so
 * every assertion is about what was *asked* for rather than what a clock happened to do.
 * `pause` itself is exercised once, at zero.
 */

import { describe, expect, it, vi } from 'vitest';
import { WaitTimeoutError } from '@/core/errors.js';
import {
	DEFAULT_POLL_INTERVAL_MS,
	type Observation,
	pause,
	settles,
	waitForCondition,
} from '@/core/wait.js';

/** A clock that advances by `stepMs` on every read, so a wait always makes progress. */
function tickingClock(stepMs: number, startMs = 1_000): () => number {
	let current = startMs - stepMs;
	return () => {
		current += stepMs;
		return current;
	};
}

/** A clock a test moves by hand. */
function manualClock(startMs = 1_000) {
	let current = startMs;
	return { now: () => current, advance: (ms: number) => (current += ms) };
}

function recordingDelay() {
	const asked: number[] = [];
	return { asked, delay: async (ms: number) => void asked.push(ms) };
}

describe('waitForCondition', () => {
	it('probes before it waits, so an already-true condition costs no delay at all', async () => {
		const { asked, delay } = recordingDelay();
		const probe = vi.fn((): Observation<string> => ({ met: true, value: 'here' }));

		await expect(
			waitForCondition({ what: 'the screen', timeoutMs: 5_000, probe, delay }),
		).resolves.toBe('here');
		expect(probe).toHaveBeenCalledTimes(1);
		expect(asked).toEqual([]);
	});

	it('probes exactly once at timeoutMs 0 — zero milliseconds is a check, not zero checks', async () => {
		const { asked, delay } = recordingDelay();
		const probe = vi.fn((): Observation<string> => ({ met: false, found: 'an empty list' }));

		await expect(
			waitForCondition({ what: 'a row', timeoutMs: 0, probe, delay }),
		).rejects.toBeInstanceOf(WaitTimeoutError);
		expect(probe).toHaveBeenCalledTimes(1);
		expect(asked).toEqual([]);
	});

	it('returns the value the probe finally reports, delaying once between each check', async () => {
		const { asked, delay } = recordingDelay();
		const seen = ['a spinner', 'a spinner'];
		const probe = vi.fn(
			(): Observation<number> =>
				seen.length > 0 ? { met: false, found: seen.pop() as string } : { met: true, value: 42 },
		);

		await expect(
			waitForCondition({
				what: 'the list to load',
				timeoutMs: 10_000,
				pollIntervalMs: 100,
				probe,
				now: tickingClock(1),
				delay,
			}),
		).resolves.toBe(42);
		expect(probe).toHaveBeenCalledTimes(3);
		expect(asked).toEqual([100, 100]);
	});

	it('throws a WaitTimeoutError carrying what it waited for and what it last found', async () => {
		const clock = manualClock();
		const found = ['a spinner', 'a spinner', 'an error banner'];
		const probe = vi.fn((): Observation<string> => {
			clock.advance(400);
			return { met: false, found: found.shift() ?? 'nothing' };
		});

		const failure = await waitForCondition({
			what: 'the list to load',
			timeoutMs: 1_000,
			pollIntervalMs: 250,
			probe,
			now: clock.now,
			delay: async () => {},
		}).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(WaitTimeoutError);
		const timeout = failure as WaitTimeoutError;
		expect(timeout.name).toBe('WaitTimeoutError');
		expect(timeout.waitedFor).toBe('the list to load');
		// The *last* observation, not the first: what is on screen now is the diagnosis.
		expect(timeout.found).toBe('an error banner');
		expect(timeout.timeoutMs).toBe(1_000);
		expect(timeout.polls).toBe(3);
		expect(timeout.message).toBe(
			'Timed out after 1000ms waiting for the list to load — found an error banner instead ' +
				'(3 checks)',
		);
	});

	it('clamps the last gap to what is left, so a wait never overshoots its own deadline', async () => {
		const { asked, delay } = recordingDelay();
		const clock = manualClock();
		const probe = vi.fn((): Observation<void> => {
			clock.advance(900);
			return { met: false, found: 'nothing yet' };
		});

		await expect(
			waitForCondition({
				what: 'a dialog',
				timeoutMs: 1_000,
				pollIntervalMs: 250,
				probe,
				now: clock.now,
				delay,
			}),
		).rejects.toBeInstanceOf(WaitTimeoutError);
		// 100ms of the deadline was left, so that — not the 250ms poll interval — is the gap.
		expect(asked).toEqual([100]);
	});

	it('lets a probe throw straight through: a broken device is not a timeout', async () => {
		class ProbeExploded extends Error {}

		await expect(
			waitForCondition({
				what: 'the screen',
				timeoutMs: 5_000,
				probe: () => {
					throw new ProbeExploded('the connection dropped');
				},
				delay: async () => {},
			}),
		).rejects.toBeInstanceOf(ProbeExploded);
	});

	it.each([
		['a negative timeout', { timeoutMs: -1 }],
		['a non-finite timeout', { timeoutMs: Number.POSITIVE_INFINITY }],
		['a zero poll interval', { timeoutMs: 100, pollIntervalMs: 0 }],
		['a negative poll interval', { timeoutMs: 100, pollIntervalMs: -5 }],
	])('rejects %s as the programmer error it is', async (_name, overrides) => {
		await expect(
			waitForCondition({
				what: 'anything',
				probe: () => ({ met: true, value: 1 }),
				delay: async () => {},
				...overrides,
			}),
		).rejects.toThrow(/waitForCondition needs/);
	});

	it('polls a quarter of a second apart unless told otherwise', async () => {
		const { asked, delay } = recordingDelay();
		let met = false;
		const probe = (): Observation<void> => {
			const observation: Observation<void> = met
				? { met: true, value: undefined }
				: { met: false, found: 'nothing' };
			met = true;
			return observation;
		};

		await waitForCondition({
			what: 'a row',
			timeoutMs: 60_000,
			probe,
			now: tickingClock(1),
			delay,
		});

		expect(asked).toEqual([DEFAULT_POLL_INTERVAL_MS]);
	});
});

describe('settles', () => {
	/** A sampler over a scripted list of readings, counting how many were taken. */
	function sampling(readings: readonly string[]) {
		let at = 0;
		return {
			taken: () => at,
			probe: settles<string>({
				sample: async () => readings[Math.min(at++, readings.length - 1)] as string,
				same: (previous, current) => previous === current,
				describe: (current) => `a reading of ${current}`,
			}),
		};
	}

	it('is never met on the first sample — there is nothing before it to compare against', async () => {
		const { probe } = sampling(['still']);

		expect(await probe()).toEqual({
			met: false,
			found: 'a reading of still, with nothing before it to compare against',
		});
	});

	it('is met on the second sample when the two match, and samples exactly once per probe', async () => {
		const { probe, taken } = sampling(['still']);

		expect(await probe()).toMatchObject({ met: false });
		expect(await probe()).toEqual({ met: true, value: 'still' });
		// Once per call, not twice: a settle over n polls costs n readings, not 2n.
		expect(taken()).toBe(2);
	});

	it('says a reading differed from the one before it, rather than only that it is unmet', async () => {
		const { probe } = sampling(['a', 'b']);

		await probe();

		expect(await probe()).toEqual({
			met: false,
			found: 'a reading of b, different from the reading before it',
		});
	});

	it('never settles a reading that changes every time, and the timeout says what it last saw', async () => {
		const { asked, delay } = recordingDelay();
		let at = 0;
		const probe = settles<number>({
			sample: async () => at++,
			same: (previous, current) => previous === current,
			describe: (current) => `a reading of ${current}`,
		});

		const thrown = await waitForCondition({
			what: 'the screen to stop moving',
			timeoutMs: 1_000,
			pollIntervalMs: 250,
			probe,
			now: tickingClock(250),
			delay,
		}).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		expect((thrown as WaitTimeoutError).found).toContain('different from the reading before it');
		expect(asked.length).toBeGreaterThan(0);
	});

	it('cannot settle at timeoutMs 0 — one check is one reading, and one reading is no comparison', async () => {
		const { asked, delay } = recordingDelay();
		const { probe, taken } = sampling(['still']);

		const thrown = await waitForCondition({
			what: 'the screen to stop moving',
			timeoutMs: 0,
			probe,
			delay,
		}).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(WaitTimeoutError);
		expect((thrown as WaitTimeoutError).found).toContain('nothing before it to compare against');
		expect(taken()).toBe(1);
		expect(asked).toEqual([]);
	});

	it('propagates a sample that throws, exactly as the probe contract says', async () => {
		const probe = settles<string>({
			sample: async () => {
				throw new Error('the device went away');
			},
			same: (previous, current) => previous === current,
			describe: (current) => current,
		});

		// Which throws mean "not yet" is the caller's to decide, not this probe's.
		await expect(probe()).rejects.toThrow('the device went away');
	});
});

describe('pause', () => {
	it('resolves, and is the one delay the repository owns', async () => {
		await expect(pause(0)).resolves.toBeUndefined();
	});
});

import { describe, expect, it } from 'vitest';
import { registerAllBackends } from '@/backends/index.js';
import { listDeviceBackends } from '@/backends/registry.js';

describe('the backend barrel', () => {
	/**
	 * The tripwire issue #2 left here for the phase that lands the first backend, flipped by
	 * it (#38) and flipped again by the second (#230): the barrel registered nothing until
	 * #38 and one platform until #230, and this asserts exactly what its import lines carry.
	 * A backend that joins without editing this line has not joined — its failure is the
	 * signal, not a regression, which is why it is an equality and not a `toContain`.
	 *
	 * **The order is the barrel's own** — the assertion is against the import lines in the
	 * order they appear there, because that is the fact this test is about. Nothing else in
	 * the repository may depend on it: `listDeviceBackends()` answers registration order and
	 * every consumer either looks a platform up or sorts for itself.
	 */
	it('registers every backend its import lines carry', () => {
		registerAllBackends();

		expect(listDeviceBackends().map((entry) => entry.manifest.platform)).toEqual([
			'android',
			'ios-simulator',
		]);
	});

	// Registration is the bare import's side effect; the exported function only makes it
	// visible at a call site. Calling it twice must therefore not register twice — the
	// registry throws on a duplicate platform id, so a second call that did any work would
	// take down every surface that wires backends up defensively.
	it('does not register a second time when the no-op is called again', () => {
		registerAllBackends();
		registerAllBackends();

		expect(listDeviceBackends()).toHaveLength(2);
	});
});

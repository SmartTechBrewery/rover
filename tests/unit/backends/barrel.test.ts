import { describe, expect, it } from 'vitest';
import { registerAllBackends } from '@/backends/index.js';
import { listDeviceBackends } from '@/backends/registry.js';

describe('the backend barrel', () => {
	/**
	 * The "ships with no backend at all" acceptance criterion of issue #2. This
	 * assertion is meant to be edited by the phase that lands the first backend — its
	 * failure is the signal that a backend joined, not a regression.
	 */
	it('registers nothing today', () => {
		registerAllBackends();

		expect(listDeviceBackends()).toEqual([]);
	});
});

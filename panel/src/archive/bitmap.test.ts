import { describe, expect, it } from 'vitest';
import { bitmapOf } from './bitmap.js';

/**
 * **jsdom has no canvas and no `HTMLImageElement.decode`**, and this is the test that says so out
 * loud rather than leaving it as a thing the next reader discovers by mocking around it.
 *
 * It is not a limitation being worked around: it is the *contract* — a browser that will not give up
 * the pixels answers `null`, the card turns that into *these two have no pixels to compare*, and
 * nothing anywhere reports a failure the reader could act on. The panel project runs in jsdom, so
 * the environment every component test runs in is one of the environments that answers this way,
 * which is why `comparison-card.test.tsx` mocks this module to have any pixels at all.
 */
describe('an artifact’s pixels', () => {
	it('are not available where the environment will not decode an image', async () => {
		expect(await bitmapOf('blob:rover-panel-test/1')).toBeNull();
	});
});

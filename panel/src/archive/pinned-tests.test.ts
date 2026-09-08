import { describe, expect, it } from 'vitest';
import { testKeyOf } from './pinned-tests.js';

/**
 * The key one `Keep` tick is held under. Nothing here is about React — that the two cards share
 * one flag is asserted where both are on one screen (`routes/archive.test.tsx`); what this file
 * pins is the identity, which is the half a hook test would not have caught.
 */
describe('the key a pinned test is held under', () => {
	/*
	 * **`project` is in the key because a test name is not an identity.** The archive's top level
	 * partitions exactly so two projects may reuse one name (`PROJECT.md` §10), and a key that
	 * dropped it would tick `login-flow` in every project at once — invisible until somebody had two.
	 */
	it('tells one project’s test from another’s of the same name', () => {
		expect(testKeyOf(['checkout-app', 'login-flow'])).not.toBe(
			testKeyOf(['payments-web', 'login-flow']),
		);
	});

	it('is the same key for the same test, whichever card asked', () => {
		expect(testKeyOf(['checkout-app', 'login-flow'])).toBe(
			testKeyOf(['checkout-app', 'login-flow']),
		);
	});

	/*
	 * **The join cannot be forged out of the components.** `keyOf` joins on NUL, which is one of the
	 * two characters an archive path component may not contain, so no pair of names can collide with
	 * a different pair. A `/` join would have: `['a/b', 'c']` and `['a', 'b/c']` are different tests
	 * and would have been one key.
	 */
	it('cannot be collided by a name that contains a separator', () => {
		expect(testKeyOf(['a/b', 'c'])).not.toBe(testKeyOf(['a', 'b/c']));
		expect(testKeyOf(['a', 'login-flow'])).not.toBe(testKeyOf(['a-login', 'flow']));
	});
});

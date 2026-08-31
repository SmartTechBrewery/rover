import { describe, expect, it } from 'vitest';

import { clearStoredSession, readStoredSession, storeSession } from './session-storage.js';

describe('session storage', () => {
	it('holds one session id under one key, and reads it back', () => {
		storeSession('a-session-id');

		expect(readStoredSession()).toBe('a-session-id');
		expect(window.localStorage.length).toBe(1);
		expect(window.localStorage.key(0)).toBe('rover.panel.session');
	});

	it('reads nothing on a cold arrival, and nothing after it is cleared', () => {
		expect(readStoredSession()).toBeUndefined();

		storeSession('a-session-id');
		clearStoredSession();

		expect(readStoredSession()).toBeUndefined();
	});

	// A browser with storage disabled throws on the property access itself, before any method is
	// called — so a panel that guarded only the calls would still fail to load.
	it('tolerates there being no storage at all', () => {
		const present = Object.getOwnPropertyDescriptor(window, 'localStorage');
		Object.defineProperty(window, 'localStorage', {
			configurable: true,
			get: () => {
				throw new Error('storage is disabled');
			},
		});

		try {
			expect(() => storeSession('a-session-id')).not.toThrow();
			expect(readStoredSession()).toBeUndefined();
			expect(() => clearStoredSession()).not.toThrow();
		} finally {
			if (present === undefined) {
				Reflect.deleteProperty(window, 'localStorage');
			} else {
				Object.defineProperty(window, 'localStorage', present);
			}
		}
	});
});

import { beforeEach } from 'vitest';

/**
 * The panel project's two pieces of environment repair: a working `localStorage`, and object URLs.
 *
 * **The trap, observed on Node v25.8.2 with jsdom 29.** Node now ships Web Storage, and its
 * `localStorage` needs `--localstorage-file` to point somewhere real. Nothing here passes one, so
 * the global exists, warns `--localstorage-file was provided without a valid path`, and evaluates to
 * a bare object with **no `getItem` and no `setItem`** — and because vitest's jsdom environment
 * makes `window` the same object as `globalThis`, that broken global is what `window.localStorage`
 * resolves to, shadowing the real Storage jsdom implements. `window.sessionStorage` is unaffected,
 * which is what makes it look like a bug in the code under test rather than in the environment.
 *
 * So the check is on the *capability*, not on the Node version: a runtime that hands out a usable
 * Storage keeps it, and only a broken one is replaced. `panel/src/session/session-storage.ts` is
 * deliberately tolerant of there being no storage at all, so without this every storage assertion
 * would pass vacuously — the module would report "no storage here" and mean it.
 */
function installStorageIfBroken(): void {
	if (typeof window.localStorage?.setItem === 'function') {
		return;
	}

	const items = new Map<string, string>();
	const storage: Storage = {
		get length() {
			return items.size;
		},
		clear: () => {
			items.clear();
		},
		getItem: (key) => items.get(key) ?? null,
		key: (index) => Array.from(items.keys())[index] ?? null,
		removeItem: (key) => {
			items.delete(key);
		},
		setItem: (key, value) => {
			items.set(key, String(value));
		},
	};

	Object.defineProperty(window, 'localStorage', {
		configurable: true,
		get: () => storage,
	});
}

/**
 * The second repair: `URL.createObjectURL` and `URL.revokeObjectURL`, which **jsdom implements
 * neither of** (#133).
 *
 * The artifact preview hands the browser an address for bytes it fetched with the session header,
 * because an authenticated route cannot be an `<img src>` (`panel/src/session/host-client.ts`).
 * Without these two functions every test that renders a preview throws inside the hook rather than
 * failing an assertion, which reads as a bug in the hook.
 *
 * Each call returns a **distinct** `blob:` string, so a test can tell one artifact's URL from
 * another's and see that a revoke matched its own create. A test that wants to assert on either
 * uses `vi.spyOn`, which `clearMocks: true` already restores between tests.
 */
function installObjectUrlsIfMissing(): void {
	if (typeof URL.createObjectURL === 'function' && typeof URL.revokeObjectURL === 'function') {
		return;
	}

	let issued = 0;
	URL.createObjectURL = () => {
		issued += 1;
		return `blob:rover-panel-test/${issued}`;
	};
	URL.revokeObjectURL = () => undefined;
}

installStorageIfBroken();
installObjectUrlsIfMissing();

// One test's stored session must never be another's starting state — the provider reads storage
// while it renders, so a leftover id changes which state a fresh mount begins in.
beforeEach(() => {
	window.localStorage.clear();
});

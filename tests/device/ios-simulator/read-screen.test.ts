import { afterAll, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import type { Device } from '@/core/device.js';
import { UnreadableScreenError } from '@/core/errors.js';
import { parseAppId, parseDeviceSerial } from '@/core/ids.js';
import { waitForCondition } from '@/core/wait.js';
import { shutDownSimulator } from '../../helpers/simulators.js';

/**
 * The screen read against a real booted simulator, through a real `idb_companion`.
 *
 * Gated on **both** flags `tests/device/setup.ts` sets — a booted simulator and a companion this
 * host can run — so a machine missing either **skips rather than fails** (ai/TESTING.md), and the
 * setup warns loudly about both.
 *
 * The mocked suite beside it proves the join with the transport replaced, and the parser and
 * mapping suites prove the projection against committed captures. What none of them can prove is
 * the claim the whole phase rests on: **that idb answers in points**, the same unit
 * `deviceInfo().screen.widthDp`/`heightDp` are in, so that a backend applying no scale conversion
 * is right rather than merely consistent with its own fixtures.
 *
 * **Almost read-only, and the exception is named rather than left to be discovered.** Every case
 * but the last reads the screen as it finds it, boots nothing, launches nothing, taps nothing and
 * changes no setting, so it is safe against a device somebody else is looking at (`docs/IOS.md`
 * §8, trap 4). The last one cannot be: the state it pins only exists while an application is
 * coming up, so it **launches Settings and reads across that launch**, then puts the device back
 * where it found it with `stopApp` and a `HOME` press — the same honesty `app-control.test.ts`
 * applies to driving Settings, and the same app, chosen because it is on every runtime and opening
 * and closing it changes nothing a person would miss. It boots nothing and shuts nothing down.
 * Nothing below hardcodes a size, a model or an app other than that one — every other assertion is
 * a property of whatever this host has booted and whatever is on its screen.
 *
 * It takes no lease, for `./backend.test.ts`' reason: every call here is a read against a device
 * nobody is holding. What it does have to clean up is a **process** — the companion this read
 * starts outlives the call by design, so the suite ends by stopping it.
 */
const backend = new IosSimulatorDeviceBackend();

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR || !process.env.ROVER_TEST_IDB)(
	'the screen read against a real simulator',
	() => {
		afterAll(async () => {
			// A companion is a process on this host that nothing else supervises, and two on one
			// udid both bind and both accept commands (`docs/IOS.md` §4).
			await backend.stopIdbCompanions();
		});

		it('reads whatever is on the screen as a non-empty list of elements', async () => {
			const device = await bootedDevice();

			const elements = await backend.readScreen(device.serial);

			expect(elements.length).toBeGreaterThan(0);
			for (const element of elements) {
				expect(element.id).not.toBe('');
				expect(Number.isFinite(element.bounds.x)).toBe(true);
				expect(Number.isFinite(element.bounds.width)).toBe(true);
			}
		});

		/**
		 * **The acceptance criterion of this phase, and the only place it can be checked against a
		 * device.**
		 *
		 * Every read carries one element covering the whole panel — the `AXApplication` node, which
		 * is there whatever is frontmost (measured against a Compose app, Settings, Safari and
		 * Springboard on this bench, 2026-09-08). Its frame has to be the screen **in dp**: on an
		 * iPhone 17 that is 402×874, where the panel is 1206×2622 px at scale 3. A mapping that
		 * divided by the scale would put 134×291 here and a mapping that multiplied would put
		 * 1206×2622, so this one assertion catches a conversion in either direction — which is what
		 * makes it worth more than a range check.
		 *
		 * The `not.toBe` on the pixel width is what keeps it from being vacuous: on a hypothetical
		 * device at scale 1 the two spellings would coincide and this would prove nothing, and the
		 * suite says so rather than passing quietly.
		 */
		it('reports frames in the same points deviceInfo reports the screen in', async () => {
			const device = await bootedDevice();

			const [elements, info] = await Promise.all([
				backend.readScreen(device.serial),
				backend.deviceInfo(device.serial),
			]);

			expect(info.screen.widthDp).not.toBe(info.screen.widthPx);
			expect(elements.map((element) => element.bounds)).toContainEqual({
				x: 0,
				y: 0,
				width: info.screen.widthDp,
				height: info.screen.heightDp,
			});
		});

		/**
		 * Unique within one read, on a real screen rather than on a capture: `findOnScreen` filters
		 * on `element.id === target.id` and treats two hits as the backend contradicting itself
		 * (`src/verbs/errors.ts`). This is also the standing check on the decision *not* to take the
		 * id from `AXUniqueId`, which repeats within a single read of Safari's start page.
		 */
		/**
		 * The state this payload carries and the state it does not (#329): `enabled` is a boolean on
		 * every element, and `clickable`/`focused` are `null` — *not answered* — because `LEGACY`
		 * carries neither. Identifiers are not asserted present: the Compose app has none, which is
		 * a true answer.
		 */
		it('answers enabled, and leaves clickable and focused not answered', async () => {
			const device = await bootedDevice();

			const elements = await backend.readScreen(device.serial);

			for (const element of elements) {
				expect(typeof element.enabled).toBe('boolean');
				expect(element.clickable).toBeNull();
				expect(element.focused).toBeNull();
			}
		});

		it('gives every element on a real screen an id no other element has', async () => {
			const device = await bootedDevice();

			const elements = await backend.readScreen(device.serial);

			expect(new Set(elements.map((element) => element.id)).size).toBe(elements.length);
		});

		/**
		 * Twice in a row, which is the companion being reused rather than restarted: the first read
		 * of a companion's life pays its start and the simulator's accessibility framework loading
		 * (3.34 s measured), and the second came back in 34–47 ms on the same bench. What is
		 * asserted is that it answers at all — the numbers are in `docs/IOS.md` rather than in a
		 * bound this suite would flake on.
		 */
		it('can be read again immediately, over the companion the first read started', async () => {
			const device = await bootedDevice();

			await backend.readScreen(device.serial);

			expect((await backend.readScreen(device.serial)).length).toBeGreaterThan(0);
		});

		/**
		 * The refusal, and the reason for it. Unlike a capture, the tool refuses this one properly —
		 * `accessibility_info` came back at 13 ms against a `Shutdown` device (`docs/IOS.md` §8) — so
		 * what the check in front of it buys is a companion that never starts for a device that
		 * cannot answer. The bound is five seconds against a refusal that is one enumeration, and
		 * what it is really here to catch is a companion having been started anyway.
		 */
		it('refuses a simulator that is not booted, quickly and by name', async () => {
			const device = await shutDownSimulator();
			if (device === null) {
				console.warn('no shut-down simulator on this host: the read refusal was NOT exercised');
				return;
			}

			const started = Date.now();
			const rejection = backend.readScreen(device.serial);

			await expect(rejection).rejects.toThrow(String(device.serial));
			await expect(rejection).rejects.toThrow(/rather than ready/);
			expect(Date.now() - started).toBeLessThan(5_000);
		});

		// The contract's own distinction from `describeDevice`'s `null`, on the real listing.
		it('throws for a device this host does not have at all', async () => {
			const rejection = backend.readScreen(
				parseDeviceSerial('00000000-0000-4000-8000-000000000000'),
			);

			await expect(rejection).rejects.toThrow(/no longer attached to this host/);
		});

		/**
		 * **The invariant #300 established, against the one window where it can be observed.**
		 *
		 * Reading as fast as the companion answers across a cold launch, every sample is either a
		 * screen — a non-empty list, with something on it that has a rectangle — or the typed
		 * {@link UnreadableScreenError}. What it must **never** be is the third thing this method
		 * used to be able to answer: a short list of nodes with no extent, which is the launching
		 * application before it has drawn and which a caller cannot tell from a real screen
		 * holding one nameless thing (`src/backends/ios-simulator/backend.ts`'s `noScreenYet`).
		 *
		 * **The reads run *beside* the launch rather than after it**, which is both what an agent
		 * does and the only way this window is reliably inside the sampling: the placeholder lives
		 * for a few hundred milliseconds from the moment the process is told to start, and a loop
		 * that waits for `launchApp` to return has already spent some of it.
		 *
		 * It does not assert that the placeholder *was* met. Whether a given run catches it is a
		 * race against how fast Settings comes up — 40 of 2623 reads across thirty launches on this
		 * bench — and a case that insisted on seeing it would be a flake rather than a check. What
		 * holds on every sample is the invariant, and the count is reported instead.
		 *
		 * **No sleeps**: the read loop is a deadline read off `Date.now()`, and the one place this
		 * case has to wait for the platform is a `waitForCondition` — the wait vocabulary, not a
		 * delay (`tests/unit/no-sleep.test.ts`, D12(b)). That wait is around the **launch**, and it
		 * is measured rather than defensive: `simctl launch` issued straight after a `terminate` of
		 * the same app fails with *"did not return a process handle nor launch error. No such
		 * process"* (seen on this bench, 2026-10-06, iOS 26.4.1), because the process it is being
		 * asked to replace has not finished going away. Retrying the launch is what the condition
		 * is; nothing about the read is retried.
		 *
		 * The companion is warmed by the cases above, so the 3.34 s first read is not inside the
		 * window.
		 */
		it('answers a screen or the typed “not ready yet”, never a tree with nothing in it', async () => {
			const device = await bootedDevice();
			const settings = parseAppId('com.apple.Preferences');

			await backend.stopApp(device.serial, settings);
			await backend.pressKey(device.serial, 'home');
			await backend.readScreen(device.serial);

			let notReadyYet = 0;
			let samples = 0;
			try {
				const launched = waitForCondition({
					what: `a cold launch of ${String(settings)} to be accepted`,
					timeoutMs: 15_000,
					probe: async () => {
						const refusal = await backend
							.launchApp(device.serial, settings)
							.then(() => null)
							.catch((error: unknown) => (error as Error).message);

						return refusal === null
							? { met: true as const, value: undefined }
							: { met: false as const, found: refusal };
					},
				});

				const deadline = Date.now() + 5_000;
				while (Date.now() < deadline) {
					const elements = await backend.readScreen(device.serial).catch((error: unknown) => {
						if (!(error instanceof UnreadableScreenError)) throw error;
						notReadyYet += 1;
						return null;
					});
					samples += 1;
					if (elements === null) continue;

					expect(elements.length).toBeGreaterThan(0);
					expect(elements.some(({ bounds }) => bounds.width > 0 && bounds.height > 0)).toBe(true);
				}

				await launched;
			} finally {
				await backend.stopApp(device.serial, settings);
				await backend.pressKey(device.serial, 'home');
			}

			expect(samples).toBeGreaterThan(0);
			console.info(
				`read across a cold launch: ${notReadyYet} of ${samples} sample(s) were "not ready yet"`,
			);
		});
	},
);

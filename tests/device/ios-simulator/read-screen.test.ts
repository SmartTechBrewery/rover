import { afterAll, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import type { Device } from '@/core/device.js';
import { parseDeviceSerial } from '@/core/ids.js';

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
 * **Read-only**: it reads the screen as it finds it, boots nothing, launches nothing, taps nothing
 * and changes no setting, so it is safe against a device somebody else is looking at
 * (`docs/IOS.md` §8, trap 4). Nothing below hardcodes a size, a model or an app — every assertion
 * is a property of whatever this host has booted and whatever is on its screen.
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

/** A simulator that is **not** booted, or `null` on a host carrying exactly one. */
async function shutDownDevice(): Promise<Device | null> {
	return (await backend.listDevices()).find((device) => device.state !== 'ready') ?? null;
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
			const device = await shutDownDevice();
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
	},
);

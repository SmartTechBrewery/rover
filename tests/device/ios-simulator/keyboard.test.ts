import { afterAll, describe, expect, it } from 'vitest';
import { IosSimulatorDeviceBackend } from '@/backends/ios-simulator/backend.js';
import type { Device } from '@/core/device.js';
import { shutDownSimulator } from '../../helpers/simulators.js';

/**
 * `ScreenInfo.keyboard` against a real booted simulator, through a real `idb_companion` (#298).
 *
 * Gated on **both** flags `tests/device/setup.ts` sets — a booted simulator and a companion this
 * host can run — so a machine missing either **skips rather than fails** (ai/TESTING.md). The
 * mocked suite beside it drives the same method with the transport replaced and the captured pair
 * served to it; what no mock can answer is whether `deviceInfo` really reaches a device for this
 * field at all, and whether it keeps answering when it cannot.
 *
 * **Nothing here sets a keyboard up, and that is a statement rather than an omission.** Drawing one
 * needs a freshly created simulator with `ConnectHardwareKeyboard` written off before its first
 * boot and `Simulator.app` attached after it (`PROJECT.md` §6, `docs/IOS.md` §8 trap 20), and
 * `docs/IOS.md` §8 trap 4 says never to do that to a device somebody may be looking at — quitting
 * or re-attaching `Simulator.app` shuts down every device it owns. So the rectangle itself is
 * pinned against the **capture** in `tests/unit/backends/ios-simulator/screen.test.ts` and the
 * refusal it causes was driven by hand and pasted into `PROJECT.md` §6.
 *
 * **So nothing below asserts `shown` either way.** Whether a panel is drawn belongs to whoever is
 * at this machine; in the configuration Rover drives there is usually none, and a case written on
 * that assumption would fail on the one bench where somebody had set the recipe up. What is pinned
 * is what holds on both: that the field is answered at all, that `shown` and `bounds` agree, and
 * that a rectangle — when there is one — is in the points the screen is.
 *
 * **It changes no device state**: it boots nothing, launches nothing, taps nothing and changes no
 * setting, so it is safe against a device somebody else is looking at. It takes no lease, for
 * `./read-screen.test.ts`' reason — every call here is a read against a device nobody is holding
 * — and it ends by stopping the companion the read started, which is the one process it leaves.
 */
const backend = new IosSimulatorDeviceBackend();

async function bootedDevice(): Promise<Device> {
	const ready = (await backend.listDevices()).filter((device) => device.state === 'ready');
	expect(ready.length).toBeGreaterThan(0);
	return ready[0] as Device;
}

describe.skipIf(!process.env.ROVER_TEST_SIMULATOR || !process.env.ROVER_TEST_IDB)(
	'the keyboard device_info reports, on a real simulator',
	() => {
		afterAll(async () => {
			await backend.stopIdbCompanions();
		});

		/**
		 * **The acceptance criterion this phase exists for, in the one form a device can check it.**
		 * Before #298 this field was the literal `null` on every iOS simulator; after it, a booted
		 * device that answers an accessibility read says something. That `not.toBeNull()` is the
		 * half that would have failed yesterday.
		 *
		 * **What it does not assert is `shown`**, and that is deliberate rather than weak: whether a
		 * panel is drawn belongs to whoever is at this machine, and a case pinned on `false` would
		 * fail on the one bench where somebody had set up the recipe. What is pinned instead is the
		 * invariant this backend cannot violate — `shown` and `bounds` agree, because a node
		 * carrying `KeyboardKey` always has a frame (`screen.ts`'s `toOnScreenKeyboard`), so
		 * `{ shown: true, bounds: null }` is a state it cannot produce.
		 */
		it('answers a measured keyboard rather than null, on a booted device', async () => {
			const device = await bootedDevice();

			const { screen } = await backend.deviceInfo(device.serial);

			expect(screen.keyboard).not.toBeNull();
			expect(screen.keyboard?.bounds === null).toBe(screen.keyboard?.shown === false);
		});

		/**
		 * **`null` has to stay reachable, and the state gate is where a device can show it.** A
		 * simulator that is not booted cannot answer an accessibility read, and reaching the tool's
		 * own refusal would mean starting a companion for it that then stays running
		 * (`backend.ts`'s `notReadable`). So the answer is *not answered* — and every other field of
		 * `device_info` is still there, which is the property that matters: this verb declares no
		 * capability and must not have acquired a new way to fail.
		 *
		 * Skipped out loud rather than quietly when this host has only the one booted simulator
		 * (ai/RULES.md §6).
		 */
		it('answers null, and every other field, for a simulator that is not booted', async () => {
			const asleep = await shutDownSimulator();
			if (asleep === null) {
				console.warn('skipped: this host has no simulator that is not booted');
				return;
			}

			const info = await backend.deviceInfo(asleep.serial);

			expect(info.screen.keyboard).toBeNull();
			expect(info.serial).toBe(asleep.serial);
			expect(info.model).toBe(asleep.model);
			expect(info.screen.widthDp).toBe(info.screen.widthPx / info.screen.densityScale);
		});

		/**
		 * **The unit, on whatever this host happens to be showing.** `bounds` is stated in the same
		 * points `widthDp` is (`src/core/device.ts`) — a mapping that divided by the scale would put
		 * a third of the screen here and one that multiplied would put three times it. The panel
		 * spans the full width on this platform (`PROJECT.md` §6), so when there is one to measure
		 * that equality is the check; when there is not, the case says out loud that it did not run
		 * rather than passing quietly (ai/RULES.md §6).
		 */
		it('reports a keyboard rectangle in the same points as the screen, when one is up', async () => {
			const device = await bootedDevice();

			const { screen } = await backend.deviceInfo(device.serial);

			if (screen.keyboard?.shown !== true) {
				console.warn(
					'skipped: no software keyboard is up on this simulator, which is the ordinary ' +
						'state in the configuration Rover drives (docs/IOS.md §8, trap 20)',
				);
				return;
			}

			expect(screen.keyboard.bounds?.width).toBe(screen.widthDp);
			expect(screen.keyboard.bounds?.x).toBe(0);
		});
	},
);

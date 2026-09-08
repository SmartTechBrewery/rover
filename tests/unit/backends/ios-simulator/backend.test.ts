import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	IosSimulatorDeviceBackend,
	WATCH_POLL_INTERVAL_MS,
} from '@/backends/ios-simulator/backend.js';
import { SimctlNotFoundError } from '@/backends/ios-simulator/developer-dir.js';
import type { Device, DeviceWatcher } from '@/core/device.js';
import { DeviceVanishedError } from '@/core/errors.js';
import { type DeviceSerial, parseDeviceSerial } from '@/core/ids.js';
import { REQUIRED_BACKEND_METHODS, STUB_SENTINEL } from '../../../helpers/backend-conformance.js';

/**
 * The backend driven off the **captured** `simctl` output of `tests/fixtures/ios-simulator/`,
 * with only the process replaced. What that proves is the join — the argv, the mapping onto the
 * neutral vocabulary, the poll's delivery rules and the screen arithmetic — and nothing
 * whatsoever about a simulator (ai/TESTING.md). `tests/device/ios-simulator/backend.test.ts` is
 * the other half.
 *
 * Nothing here runs `xcrun`, boots anything or reads `DEVELOPER_DIR`, so the suite passes on a
 * machine with no simulator and no Xcode at all — the property this whole folder was written to
 * keep (`./simctl.test.ts`).
 *
 * **The one thing the capture cannot carry is a readable `profile.plist`.** Every `bundlePath` in
 * it points under `/Library/Developer/CoreSimulator/`, which exists only on a Mac with those
 * device types installed, and a suite reading from there would be asserting against whichever
 * Xcode the machine happens to have. So {@link listing} redirects **every** device type's
 * `bundlePath` into a `mkdtemp` directory of this suite's own — that one field, the rest of the
 * document verbatim — and three bundles are built inside it: two holding the committed profiles
 * copied byte for byte, one holding bytes that are not a property list. Every other device type
 * therefore resolves to a bundle that is not there, which is what gives the missing-profile case
 * its input.
 */
type Runner = typeof import('@/backends/ios-simulator/simctl.js');

const { runSimctl } = vi.hoisted(() => ({ runSimctl: vi.fn<Runner['runSimctl']>() }));

vi.mock('@/backends/ios-simulator/simctl.js', async (importOriginal) => ({
	...(await importOriginal<Runner>()),
	runSimctl,
}));

const fixtureUrl = (name: string): URL =>
	new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url);

/** `xcrun simctl list -j` — the all-listings capture, read once because every case re-parses it. */
const CAPTURE = readFileSync(fixtureUrl('simctl-list.xcode26.4.1-ios26.4.1.json'), 'utf8');

/** The argv of the two commands this backend makes, pinned as literals rather than as constants. */
const ENUMERATE = ['list', '-j', 'devices', 'runtimes'];
const DEVICE_FACTS = ['list', '-j', 'devices', 'runtimes', 'devicetypes'];

/** Four devices out of the capture, each here for something different. */
const BOOTED = parseDeviceSerial('997FA43E-FF9F-4109-BEF0-53D3F46653E7'); // iPhone 17, Booted
const IPHONE_17_PRO = parseDeviceSerial('1974C124-3582-4D07-89BB-B4BA3B03D32F'); // Shutdown
const IPAD_PRO_13_M5 = parseDeviceSerial('4C9B1ED2-9E8E-40FF-878A-194EFBA406A6'); // Shutdown
/** A device whose type this suite deliberately builds no bundle for. */
const NO_BUNDLE = parseDeviceSerial('6F3E38EF-81D2-4AF0-818A-C8F8F2931A6D'); // iPhone 17 Pro Max
const GONE = parseDeviceSerial('00000000-0000-4000-8000-000000000000');

const IPHONE_17_PRO_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro';
const IPAD_PRO_13_M5_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB';
/** The booted iPhone 17's type — given a bundle holding junk rather than a plist. */
const IPHONE_17_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17';
const NO_BUNDLE_TYPE = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max';

/** Enough of the document to redirect one field of; every other key is passed through. */
interface Listing {
	devicetypes: Array<{ identifier: string; bundlePath: string }>;
	devices: Record<string, Array<Record<string, unknown>>>;
}

let bundleRoot: string;

/** `<root>/<identifier>.simdevicetype` — one name per type, so no two cases share a bundle. */
const bundleOf = (identifier: string): string => join(bundleRoot, `${identifier}.simdevicetype`);

/**
 * Where a profile goes inside a bundle, spelled out here rather than taken from `screen.ts`'s
 * `deviceTypeProfilePath`: placing the fixture with the function under test would make the read
 * pass whatever that function computes, the wrong thing included.
 */
async function bundleHolding(identifier: string, profile: Uint8Array | URL): Promise<void> {
	const resources = join(bundleOf(identifier), 'Contents', 'Resources');
	await mkdir(resources, { recursive: true });
	const at = join(resources, 'profile.plist');
	if (profile instanceof URL) await copyFile(profile, at);
	else await writeFile(at, profile);
}

beforeAll(async () => {
	bundleRoot = await mkdtemp(join(tmpdir(), 'rover-simdevicetype-'));
	await bundleHolding(
		IPHONE_17_PRO_TYPE,
		fixtureUrl('device-type-profile.iphone-17-pro.xcode26.4.1.plist'),
	);
	await bundleHolding(
		IPAD_PRO_13_M5_TYPE,
		fixtureUrl('device-type-profile.ipad-pro-13-inch-m5.xcode26.4.1.plist'),
	);
	await bundleHolding(IPHONE_17_TYPE, new TextEncoder().encode('not a property list\n'));
});

afterAll(async () => {
	await rm(bundleRoot, { recursive: true, force: true });
});

/**
 * The capture, with every `bundlePath` pointing inside this suite's own directory and whatever
 * `edit` asks changed. `edit` is how a case says what it is about — a state flipped, a device
 * removed, a device renamed — so nothing here hand-writes a listing.
 */
function listing(edit: (parsed: Listing) => void = () => {}): string {
	const parsed = JSON.parse(CAPTURE) as Listing;
	for (const type of parsed.devicetypes) type.bundlePath = bundleOf(type.identifier);
	edit(parsed);
	return JSON.stringify(parsed);
}

/** The same capture with one device deleted — a simulator somebody removed. */
const withoutDevice = (serial: DeviceSerial): string =>
	listing((parsed) => {
		for (const [runtime, entries] of Object.entries(parsed.devices)) {
			parsed.devices[runtime] = entries.filter((entry) => entry.udid !== serial);
		}
	});

function answers(stdout: string, stderr = ''): void {
	runSimctl.mockResolvedValue({ stdout, stderr });
}

/** Every device of the listing, whichever runtime it is under. */
const entriesOf = (parsed: Listing): Array<Record<string, unknown>> =>
	Object.values(parsed.devices).flat();

function entryOf(parsed: Listing, udid: string): Record<string, unknown> {
	const found = entriesOf(parsed).find((entry) => entry.udid === udid);
	if (found === undefined) throw new Error(`the capture no longer carries ${udid}`);
	return found;
}

let backend = new IosSimulatorDeviceBackend();

beforeEach(() => {
	backend = new IosSimulatorDeviceBackend();
	runSimctl.mockReset();
});

describe('listDevices', () => {
	/**
	 * The criterion the whole enumeration rests on: **one** invocation carrying both listings.
	 * Two would let the pair disagree — a runtime uninstalled between them reports a device
	 * without a version that has one.
	 */
	it('asks for both listings in one invocation', async () => {
		answers(listing());

		await backend.listDevices();

		expect(runSimctl).toHaveBeenCalledTimes(1);
		expect(runSimctl.mock.calls[0]?.[0]).toEqual(ENUMERATE);
	});

	// Counted so a mapping that silently read nothing cannot pass: 22 devices across the two
	// installed runtimes, exactly one of them booted.
	it('answers the neutral device set, mapped off the capture', async () => {
		answers(listing());

		const devices = await backend.listDevices();

		expect(devices).toHaveLength(22);
		expect(devices.filter((device) => device.state === 'ready')).toHaveLength(1);
		expect(devices.find((device) => device.serial === BOOTED)).toEqual({
			serial: BOOTED,
			platform: 'ios-simulator',
			model: 'iPhone 17',
			// The runtime's own `version`, never the map key's `iOS-26-4`.
			osVersion: '26.4.1',
			osApiLevel: null,
			state: 'ready',
			attachment: 'this-host',
		});
	});

	// D6: the device list is never cached, so a second call is a second invocation.
	it('re-reads the device set on every call rather than remembering one', async () => {
		answers(listing());

		await backend.listDevices();
		await backend.listDevices();

		expect(runSimctl).toHaveBeenCalledTimes(2);
	});

	it('reports a host with no simulators created as an empty list, not a failure', async () => {
		answers(JSON.stringify({ devices: {}, runtimes: [], devicetypes: [] }));

		expect(await backend.listDevices()).toEqual([]);
	});

	/**
	 * The failure `parsers/simctl-list.ts` was written for: on a machine whose `xcode-select`
	 * points at CommandLineTools the answer is a sentence, not JSON. What makes it diagnosable is
	 * the command and the stream the parser never saw — a successful `simctl io` writes to stderr
	 * on this platform, so "was there anything there?" is a real question and `(empty)` answers it.
	 */
	it('wraps an answer that is not JSON with the command and stderr', async () => {
		answers('unable to find utility simctl', 'and this is where the reason would be');

		const rejection = backend.listDevices();

		await expect(rejection).rejects.toThrow('simctl list -j devices runtimes');
		await expect(rejection).rejects.toThrow('output is not JSON');
		await expect(rejection).rejects.toThrow('stderr: and this is where the reason would be');
	});

	it('quotes an empty stderr rather than leaving the question open', async () => {
		answers('not json at all');

		await expect(backend.listDevices()).rejects.toThrow('stderr: (empty)');
	});

	it('lets a failed run surface as the runner reported it', async () => {
		runSimctl.mockRejectedValue(new Error('simctl list -j devices runtimes exited 1'));

		await expect(backend.listDevices()).rejects.toThrow('simctl list -j devices runtimes exited 1');
	});
});

describe('describeDevice', () => {
	it('answers the one device the serial names, off one enumeration', async () => {
		answers(listing());

		const device = await backend.describeDevice(BOOTED);

		expect(device?.serial).toBe(BOOTED);
		expect(device?.state).toBe('ready');
		expect(runSimctl).toHaveBeenCalledTimes(1);
		expect(runSimctl.mock.calls[0]?.[0]).toEqual(ENUMERATE);
	});

	/**
	 * D6's re-verification in its cheapest form, and the distinction the contract draws against
	 * `deviceInfo`: a device that is no longer there is a lookup miss, not a failure.
	 */
	it('answers null for a device the enumeration does not name', async () => {
		answers(listing());

		expect(await backend.describeDevice(GONE)).toBeNull();
	});

	// A simulator deleted between two calls, which is what the miss above really is.
	it('answers null for a device that has just left the set', async () => {
		answers(listing());
		expect(await backend.describeDevice(BOOTED)).not.toBeNull();

		answers(withoutDevice(BOOTED));

		expect(await backend.describeDevice(BOOTED)).toBeNull();
	});
});

/**
 * The poll, with the timer under the test's control so nothing here waits on a duration
 * (ai/RULES.md §2). What it proves is the delivery rules: the full set on subscription, again
 * only when the *devices* differ, an interruption that keeps polling, and a stop nothing outlives.
 */
describe('watchDevices', () => {
	function watcher(): DeviceWatcher & {
		onDevices: ReturnType<typeof vi.fn>;
		onInterrupted: ReturnType<typeof vi.fn>;
	} {
		return { onDevices: vi.fn(), onInterrupted: vi.fn() };
	}

	/** The sets a listener was handed, in order. */
	const sets = (listener: { onDevices: ReturnType<typeof vi.fn> }): Device[][] =>
		listener.onDevices.mock.calls.map(([devices]) => devices as Device[]);

	/** Let the poll already in flight settle, without advancing the gap. */
	const settle = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(0);
	};

	/** Reach the next poll and let it settle. */
	const nextPoll = async (): Promise<void> => {
		await vi.advanceTimersByTimeAsync(WATCH_POLL_INTERVAL_MS);
	};

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('starts as soon as it is asked to, with the enumeration’s own argv', async () => {
		answers(listing());

		backend.watchDevices(watcher());
		await settle();

		expect(runSimctl).toHaveBeenCalledTimes(1);
		expect(runSimctl.mock.calls[0]?.[0]).toEqual(ENUMERATE);
	});

	it('delivers the full current set on subscription', async () => {
		answers(listing());
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();

		expect(sets(listener)).toHaveLength(1);
		expect(sets(listener)[0]).toHaveLength(22);
		expect(sets(listener)[0]?.find((device) => device.serial === BOOTED)?.state).toBe('ready');
	});

	it('delivers nothing when the next poll finds the same device set', async () => {
		answers(listing());
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();
		await nextPoll();
		await nextPoll();

		expect(runSimctl).toHaveBeenCalledTimes(3);
		expect(sets(listener)).toHaveLength(1);
	});

	/**
	 * Why the comparison is over the mapped `Device[]` and not over what the tool printed: every
	 * device entry carries a `dataPathSize` that moves as the simulator writes to its own disk, so
	 * a raw comparison would report a device change every poll, on an idle host, forever.
	 */
	it('is silent about a listing that changed without any device changing', async () => {
		answers(listing());
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();

		answers(
			listing((parsed) => {
				for (const entry of entriesOf(parsed)) entry.dataPathSize = 1_234_567_890;
			}),
		);
		await nextPoll();

		expect(sets(listener)).toHaveLength(1);
	});

	it('delivers the full set again when a device changes state', async () => {
		answers(listing());
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();

		answers(
			listing((parsed) => {
				entryOf(parsed, BOOTED).state = 'Shutdown';
			}),
		);
		await nextPoll();

		expect(sets(listener)).toHaveLength(2);
		expect(sets(listener)[1]).toHaveLength(22);
		expect(sets(listener)[1]?.find((device) => device.serial === BOOTED)?.state).toBe('offline');
	});

	/** Never a delta: a device leaving is the whole remaining set, not the one that went. */
	it('delivers the whole remaining set when a device goes away, never a delta', async () => {
		answers(listing());
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();

		answers(withoutDevice(BOOTED));
		await nextPoll();

		expect(sets(listener)[1]).toHaveLength(21);
		expect(sets(listener)[1]?.some((device) => device.serial === BOOTED)).toBe(false);
	});

	/**
	 * The order is the tool's — the device map is keyed by runtime — so two polls that agree about
	 * every device may still disagree about which runtime came first. That is not a device change.
	 */
	it('is silent when only the order the tool printed changed', async () => {
		answers(listing());
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();

		answers(
			listing((parsed) => {
				parsed.devices = Object.fromEntries(Object.entries(parsed.devices).reverse());
				for (const entries of Object.values(parsed.devices)) entries.reverse();
			}),
		);
		await nextPoll();

		expect(sets(listener)).toHaveLength(1);
	});

	it('reports a failed poll as an interruption and keeps polling', async () => {
		runSimctl.mockRejectedValueOnce(new Error('simctl list -j devices runtimes exited 1'));
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();

		expect(listener.onInterrupted).toHaveBeenCalledWith(
			'simctl list -j devices runtimes exited 1',
			// No cause: this is expected to clear, which is every failure here but one.
			null,
		);
		expect(listener.onDevices).not.toHaveBeenCalled();

		answers(listing());
		await nextPoll();

		expect(sets(listener)).toHaveLength(1);
	});

	/**
	 * The distinction #168 exists to make: a failure that will clear on its own and one that never
	 * will read identically on every surface unless the backend says which it is. There being no
	 * `simctl` to run is the second kind — a Command Line Tools selection does not start carrying
	 * one — and the program's name is what makes a client's message actionable without the client
	 * knowing anything about Xcode.
	 */
	it('names simctl as the cause when there was none to run', async () => {
		runSimctl.mockRejectedValue(new SimctlNotFoundError([]));
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();

		expect(listener.onInterrupted).toHaveBeenCalledWith(expect.any(String), {
			cause: 'tooling-missing',
			tool: 'simctl',
		});
	});

	/*
	 * And it is not a reason to stop trying: `DEVELOPER_DIR` fixed on a running daemon is exactly
	 * what the next poll picks up, since that search is re-run per call and unmemoised.
	 */
	it('keeps polling when there was no simctl to run at all', async () => {
		runSimctl.mockRejectedValue(new SimctlNotFoundError([]));

		backend.watchDevices(watcher());
		await settle();
		await nextPoll();

		expect(runSimctl).toHaveBeenCalledTimes(2);
	});

	/**
	 * An interruption tells the caller that what it last saw is no longer known to be current, so
	 * the next successful poll has to deliver even when the set is unchanged. Suppressing it as
	 * "no change" would leave the caller holding a set it has been told to distrust until a device
	 * happens to move.
	 */
	it('delivers the set again after an interruption, even when nothing changed', async () => {
		answers(listing());
		const listener = watcher();

		backend.watchDevices(listener);
		await settle();
		expect(sets(listener)).toHaveLength(1);

		runSimctl.mockRejectedValueOnce(new Error('simctl list -j devices runtimes exited 1'));
		await nextPoll();
		answers(listing());
		await nextPoll();

		expect(sets(listener)).toHaveLength(2);
		expect(sets(listener)[1]).toEqual(sets(listener)[0]);
	});

	// Synchronous and never rejecting: the first poll is started rather than awaited, so a failure
	// that happens immediately arrives through the listener like every later one.
	it('answers with its handle synchronously, even when the first poll fails', async () => {
		runSimctl.mockRejectedValue(new Error('simctl list -j devices runtimes exited 1'));
		const listener = watcher();

		const watch = backend.watchDevices(listener);

		expect(typeof watch.stop).toBe('function');
		expect(listener.onInterrupted).not.toHaveBeenCalled();
		await settle();
		expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
	});

	it('stops polling and calls no handler after stop', async () => {
		answers(listing());
		const listener = watcher();

		const watch = backend.watchDevices(listener);
		await settle();
		await watch.stop();
		listener.onDevices.mockClear();

		answers(withoutDevice(BOOTED));
		await nextPoll();
		await nextPoll();

		expect(runSimctl).toHaveBeenCalledTimes(1);
		expect(listener.onDevices).not.toHaveBeenCalled();
		expect(listener.onInterrupted).not.toHaveBeenCalled();
	});

	/**
	 * The half a cleared timer does not cover: a poll already talking to `simctl` when the watch
	 * stopped. Its answer is dropped rather than delivered, which is what "no listener method is
	 * called after this" has to mean for a poll that cannot be cancelled.
	 */
	it('drops the answer of a poll that was in flight when it stopped', async () => {
		let answer: (result: { stdout: string; stderr: string }) => void = () => {};
		runSimctl.mockImplementation(
			async () =>
				new Promise((resolve) => {
					answer = resolve;
				}),
		);
		const listener = watcher();

		const watch = backend.watchDevices(listener);
		await watch.stop();
		answer({ stdout: listing(), stderr: '' });
		await settle();

		expect(listener.onDevices).not.toHaveBeenCalled();
		expect(listener.onInterrupted).not.toHaveBeenCalled();
	});

	it('drops the failure of a poll that was in flight when it stopped', async () => {
		let fail: (error: Error) => void = () => {};
		runSimctl.mockImplementation(
			async () =>
				new Promise((_resolve, reject) => {
					fail = reject;
				}),
		);
		const listener = watcher();

		const watch = backend.watchDevices(listener);
		await watch.stop();
		fail(new Error('simctl list -j devices runtimes exited 1'));
		await settle();

		expect(listener.onInterrupted).not.toHaveBeenCalled();
	});

	it('treats a second stop as a no-op rather than an error', async () => {
		answers(listing());

		const watch = backend.watchDevices(watcher());
		await settle();

		await expect(watch.stop()).resolves.toBeUndefined();
		await expect(watch.stop()).resolves.toBeUndefined();
	});
});

/**
 * The device facts. Every number below comes from the committed `profile.plist` of the device type
 * the capture says the simulator was created from — the join this method exists to make.
 */
describe('deviceInfo', () => {
	it('asks for the three listings it joins in one invocation', async () => {
		answers(listing());

		await backend.deviceInfo(IPHONE_17_PRO);

		expect(runSimctl).toHaveBeenCalledTimes(1);
		expect(runSimctl.mock.calls[0]?.[0]).toEqual(DEVICE_FACTS);
	});

	/**
	 * `density` is a **dpi** and `densityScale` a ratio, taken from two different plist keys — the
	 * distinction idb's own `describe` loses by reporting `density: 3.0`, which would put a number
	 * 153 times too small in the field (`docs/IOS.md` §8, trap 6).
	 */
	it('reports the screen of the device type the simulator was created from', async () => {
		answers(listing());

		expect(await backend.deviceInfo(IPHONE_17_PRO)).toEqual({
			serial: IPHONE_17_PRO,
			platform: 'ios-simulator',
			model: 'iPhone 17 Pro',
			screen: {
				widthPx: 1206,
				heightPx: 2622,
				density: 460,
				densityScale: 3,
				widthDp: 402,
				heightDp: 874,
			},
			osVersion: '26.4.1',
			osApiLevel: null,
		});
	});

	/**
	 * The second device type is here for its **scale**: with one fixture the conversion could be
	 * pinned on the number 3 and nothing would notice it was a constant rather than a division.
	 */
	it('divides by the device type’s own scale rather than by a constant', async () => {
		answers(listing());

		const info = await backend.deviceInfo(IPAD_PRO_13_M5);

		expect(info.screen).toEqual({
			widthPx: 2064,
			heightPx: 2752,
			density: 264,
			densityScale: 2,
			widthDp: 1032,
			heightDp: 1376,
		});
	});

	it.each([
		['an iPhone', IPHONE_17_PRO],
		['an iPad', IPAD_PRO_13_M5],
	])('answers a dp size that is exactly the pixels over the scale, on %s', async (_at, serial) => {
		answers(listing());

		const { screen } = await backend.deviceInfo(serial);

		expect(screen.widthDp).toBe(screen.widthPx / screen.densityScale);
		expect(screen.heightDp).toBe(screen.heightPx / screen.densityScale);
		expect(screen.density).not.toBe(screen.densityScale);
	});

	/**
	 * A property of reading the screen off the device type rather than off the device: it needs no
	 * booted simulator. Both devices asserted above are `Shutdown` in the capture, and this says
	 * so deliberately rather than leaving it to be noticed.
	 */
	it('answers for a device that is not booted', async () => {
		answers(listing());

		const device = (await backend.listDevices()).find((entry) => entry.serial === IPHONE_17_PRO);

		expect(device?.state).toBe('offline');
		expect((await backend.deviceInfo(IPHONE_17_PRO)).screen.widthPx).toBe(1206);
	});

	/**
	 * The documented choice: `model` is the simulator's own `name`, which is **operator-chosen**,
	 * and not the device type's `name` or `modelIdentifier`. `DeviceInfo.model` is the same field
	 * as `Device.model` under the same name, so reporting the hardware model here would make
	 * `list_devices` and `device_info` disagree about what one device is called.
	 */
	it('reports the simulator’s own name, not its device type’s', async () => {
		answers(
			listing((parsed) => {
				entryOf(parsed, IPHONE_17_PRO).name = 'the one on the left';
			}),
		);

		const info = await backend.deviceInfo(IPHONE_17_PRO);

		expect(info.model).toBe('the one on the left');
		expect(info.screen.density).toBe(460);
	});

	// The contract's own distinction from `describeDevice`: `null` there is a lookup miss, and
	// reusing it here would make "no such device" indistinguishable from "the query failed".
	it('throws rather than answering null for a device the enumeration does not name', async () => {
		answers(listing());

		const rejection = backend.deviceInfo(GONE);

		await expect(rejection).rejects.toBeInstanceOf(DeviceVanishedError);
		await expect(rejection).rejects.toThrow(GONE);
	});

	it('throws naming the device type when the listing does not resolve it', async () => {
		answers(
			listing((parsed) => {
				parsed.devicetypes = parsed.devicetypes.filter(
					(type) => type.identifier !== IPHONE_17_PRO_TYPE,
				);
			}),
		);

		const rejection = backend.deviceInfo(IPHONE_17_PRO);

		await expect(rejection).rejects.toThrow(IPHONE_17_PRO_TYPE);
		await expect(rejection).rejects.toThrow(IPHONE_17_PRO);
	});

	// Never a plausible-looking screen: a bundle that is not there is a device with no screen to
	// report, and the path is what an operator can go and look at.
	it('throws naming the profile when the bundle holds none', async () => {
		answers(listing());

		const rejection = backend.deviceInfo(NO_BUNDLE);

		await expect(rejection).rejects.toThrow('profile.plist');
		await expect(rejection).rejects.toThrow(NO_BUNDLE_TYPE);
	});

	it('throws naming the profile when the file is not a property list', async () => {
		answers(listing());

		const rejection = backend.deviceInfo(BOOTED);

		await expect(rejection).rejects.toThrow('profile.plist');
		await expect(rejection).rejects.toThrow('not a readable binary property list');
	});

	it('wraps an answer that is not JSON with the command it came from', async () => {
		answers('unable to find utility simctl');

		await expect(backend.deviceInfo(IPHONE_17_PRO)).rejects.toThrow(
			'simctl list -j devices runtimes devicetypes',
		);
	});
});

/**
 * The required methods the later phases own, held to the sentinel the conformance gate scans for
 * (`tests/helpers/backend-conformance.ts`).
 *
 * Driven off `REQUIRED_BACKEND_METHODS` rather than a list written here, so a method added to
 * `DeviceBackend` joins this suite with no edit — and counted, so the phase that implements one
 * has to change the count deliberately rather than have the case quietly pass on a shorter list.
 */
describe('the methods a later phase fills in', () => {
	const ANSWERED: readonly string[] = [
		'listDevices',
		'watchDevices',
		'describeDevice',
		'deviceInfo',
	];
	const STUBBED = REQUIRED_BACKEND_METHODS.filter((name) => !ANSWERED.includes(name));

	it('is every required method this phase does not answer', () => {
		expect(STUBBED).toHaveLength(8);
	});

	it.each(STUBBED)('%s throws the not-implemented sentinel', async (name) => {
		const method = backend[name] as unknown as () => Promise<unknown>;

		await expect(method.call(backend)).rejects.toThrow(STUB_SENTINEL);
		expect(String(backend[name])).toMatch(STUB_SENTINEL);
	});

	it.each(ANSWERED)('%s carries no sentinel, because it is real', (name) => {
		expect(String(backend[name as keyof IosSimulatorDeviceBackend])).not.toMatch(STUB_SENTINEL);
	});
});

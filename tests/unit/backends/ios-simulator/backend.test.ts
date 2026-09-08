import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	IosSimulatorDeviceBackend,
	LOG_WINDOWS,
	WATCH_POLL_INTERVAL_MS,
} from '@/backends/ios-simulator/backend.js';
import { SimctlNotFoundError } from '@/backends/ios-simulator/developer-dir.js';
import { IdbCompanionInterruptedError } from '@/backends/ios-simulator/idb-client.js';
import type { IdbCompanionStreamHandlers } from '@/backends/ios-simulator/idb-companion.js';
import { IdbCompanionNotFoundError } from '@/backends/ios-simulator/idb-companion-path.js';
import {
	READ_SCREEN_BLANKED_ARGV,
	SCREEN_BLANKED_NOTIFICATION,
} from '@/backends/ios-simulator/input.js';
import { PNG_SIGNATURE } from '@/backends/ios-simulator/parsers/png.js';
import {
	INSTALL_SIMCTL_TIMEOUT_MS,
	READ_LOGS_SIMCTL_MAX_BUFFER_BYTES,
	SCREENSHOT_SIMCTL_TIMEOUT_MS,
	SimctlCommandError,
} from '@/backends/ios-simulator/simctl.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import {
	DeviceVanishedError,
	FileTooLargeError,
	NoRecordingRunningError,
	RecordingAlreadyRunningError,
	UnfinishedRecordingError,
	UnsupportedKeyError,
	UnsupportedTextError,
} from '@/core/errors.js';
import {
	type AppId,
	type DeviceSerial,
	parseAppId,
	parseDeviceSerial,
	unwrap,
} from '@/core/ids.js';
import { MAX_LOG_ENTRIES } from '@/ipc/verb-methods.js';
import { REQUIRED_BACKEND_METHODS, STUB_SENTINEL } from '../../../helpers/backend-conformance.js';
import { drainEventLoop } from '../../../helpers/timing.js';

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

/**
 * **Both** runners are replaced, not just the plain one. `runSimctlOnDevice` closes over the
 * module's own `runSimctl` rather than over the mocked binding, so leaving it real would put
 * every device-pinned call of this suite through `execFile` and onto whatever simulator the
 * machine running it happens to have. Stubbing it also makes the pin itself assertable: a method
 * that reached `runSimctl` directly with a udid it assembled would show up here as the wrong mock
 * being called.
 */
const { readProcessTable, runSimctl, runSimctlOnDevice, streamSimctlOnDevice } = vi.hoisted(() => ({
	readProcessTable: vi.fn<Runner['readProcessTable']>(),
	runSimctl: vi.fn<Runner['runSimctl']>(),
	runSimctlOnDevice: vi.fn<Runner['runSimctlOnDevice']>(),
	streamSimctlOnDevice: vi.fn<Runner['streamSimctlOnDevice']>(),
}));

vi.mock('@/backends/ios-simulator/simctl.js', async (importOriginal) => ({
	...(await importOriginal<Runner>()),
	readProcessTable,
	runSimctl,
	runSimctlOnDevice,
	streamSimctlOnDevice,
}));

/**
 * The companion runner, replaced so this suite spawns no process and needs no idb.
 *
 * Only the runner: the frame decoder, the mapping onto the neutral vocabulary and the search's
 * own failure class stay real, because those are what the watch's behaviour is *made* of — a
 * suite that stubbed the decoder too would assert its own fixtures rather than the join.
 * `./idb-companion.test.ts` is where a real companion process is driven.
 */
type Companion = typeof import('@/backends/ios-simulator/idb-companion.js');

const { streamIdbCompanion } = vi.hoisted(() => ({
	streamIdbCompanion: vi.fn<Companion['streamIdbCompanion']>(),
}));

vi.mock('@/backends/ios-simulator/idb-companion.js', async (importOriginal) => ({
	...(await importOriginal<Companion>()),
	streamIdbCompanion,
}));

/**
 * The companion **pool**, replaced for the same reason and one further out.
 *
 * `streamIdbCompanion` above is enough for the watch, which reads a stdout pipe; a screen read is
 * a gRPC call, so leaving the pool real would make every `readScreen` case here stand up a server
 * and assert against it. What is worth proving at this layer is the join — the state check in
 * front of the call, the RPC and request the call is made with, and the mapping of what comes back
 * — so the transport is the thing stubbed and `./idb-client.test.ts` is where a real channel is
 * driven. The parsing stays real: the payload these cases hand back is a **captured** one.
 */
type IdbClient = typeof import('@/backends/ios-simulator/idb-client.js');

const { companionCall, companionStream, companionStopAll } = vi.hoisted(() => ({
	companionCall: vi.fn<InstanceType<IdbClient['IdbCompanions']>['call']>(),
	companionStream: vi.fn<InstanceType<IdbClient['IdbCompanions']>['stream']>(),
	companionStopAll: vi.fn<InstanceType<IdbClient['IdbCompanions']>['stopAll']>(),
}));

vi.mock('@/backends/ios-simulator/idb-client.js', async (importOriginal) => ({
	...(await importOriginal<IdbClient>()),
	IdbCompanions: class {
		call = companionCall;
		stream = companionStream;
		stopAll = companionStopAll;
	},
}));

const fixtureUrl = (name: string): URL =>
	new URL(`../../../fixtures/ios-simulator/${name}`, import.meta.url);

/** `xcrun simctl list -j` — the all-listings capture, read once because every case re-parses it. */
const CAPTURE = readFileSync(fixtureUrl('simctl-list.xcode26.4.1-ios26.4.1.json'), 'utf8');

/**
 * `idb_companion --notify stdout`, captured on this repository's own bench while one simulator
 * was booted and shut down again: five frames of eleven targets each
 * (`tests/fixtures/ios-simulator/README.md`).
 *
 * Kept as the **lines the companion printed** rather than as decoded frames, so the watch cases
 * hand the backend bytes and the real decoder is what reads them — the boundary a frame ends on
 * is the one thing a hand-written fixture cannot get right.
 */
const NOTIFY_FRAMES = readFileSync(
	fixtureUrl('idb-notify.idbcompanion1.5.2-xcode26.6-ios26.5.txt'),
	'utf8',
)
	.split('\n')
	.filter((line) => line !== '');

/** The one target of that capture whose state moved: `Shutdown → Booting → Booted → …`. */
const TRANSITIONING = parseDeviceSerial('D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F');

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

/**
 * A `SimctlCommandError` as the runner would have built it, with a captured stderr — the shape
 * every method here has to keep letting through rather than reinterpret. Module-scoped because
 * three suites below need one.
 */
function refusedWith(exitCode: number, stderr: string): SimctlCommandError {
	return new SimctlCommandError(
		['terminate', BOOTED, 'com.rover.testapp'],
		10_000,
		Object.assign(new Error('simctl failed'), { code: exitCode }),
		'',
		stderr,
	);
}

function entryOf(parsed: Listing, udid: string): Record<string, unknown> {
	const found = entriesOf(parsed).find((entry) => entry.udid === udid);
	if (found === undefined) throw new Error(`the capture no longer carries ${udid}`);
	return found;
}

let backend = new IosSimulatorDeviceBackend();

beforeEach(() => {
	backend = new IosSimulatorDeviceBackend();
	runSimctl.mockReset();
	runSimctlOnDevice.mockReset();
	runSimctlOnDevice.mockResolvedValue({ stdout: '', stderr: '' });
	readProcessTable.mockReset();
	// Nothing recording, which is what nearly every case starts from — and the honest default,
	// because an idle host is what `ps` says on one.
	readProcessTable.mockResolvedValue('');
	streamSimctlOnDevice.mockReset();
	streamIdbCompanion.mockReset();
	companionCall.mockReset();
	companionStream.mockReset();
	companionStopAll.mockReset();
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
 * The watch, with **both** its sources under the test's control and nothing waiting on a duration
 * (ai/RULES.md §2). What it proves is the delivery rules the contract states once and this
 * backend now satisfies two ways: the full set on subscription, again only when the *devices*
 * differ, a lost view that is one interruption and never an empty set, and a stop nothing
 * outlives.
 *
 * The companion is mocked at the runner rather than spawned — `./idb-companion.test.ts` is where
 * a real process is driven, and what this file is about is the join above it: which frames become
 * which device sets, when the poll takes over, and when it hands back.
 */
describe('watchDevices', () => {
	/** The handlers the backend passed to the runner, per companion it started. */
	let companions: IdbCompanionStreamHandlers[];
	let stops: Array<ReturnType<typeof vi.fn>>;

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

	/** One captured frame, delivered the way the companion writes it: the line and its newline. */
	const frame = (index: number): Buffer => Buffer.from(`${NOTIFY_FRAMES[index]}\n`);

	/** The companion the backend started last — the live one, or the one that just ended. */
	function live(): IdbCompanionStreamHandlers {
		const handlers = companions.at(-1);
		if (handlers === undefined) throw new Error('the backend started no companion');
		return handlers;
	}

	/** The live companion ended, for whatever reason, with whatever it last said on stderr. */
	const dies = (reason = 'idb_companion --notify stdout ended with exit 0'): void => {
		live().onEnd(reason);
	};

	beforeEach(() => {
		vi.useFakeTimers();
		companions = [];
		stops = [];
		streamIdbCompanion.mockImplementation((_args, handlers) => {
			companions.push(handlers);
			const stop = vi.fn(async () => {});
			stops.push(stop);
			return { stop };
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * The stream, which is the contract itself rather than an approximation of it: the companion
	 * prints the whole target set on every change, so a frame *is* an `onDevices` and nothing here
	 * polls anything.
	 */
	describe('on the notify stream', () => {
		it('starts one companion for the host, in notify mode and pinned to no device', () => {
			backend.watchDevices(watcher());

			expect(streamIdbCompanion).toHaveBeenCalledTimes(1);
			expect(streamIdbCompanion.mock.calls[0]?.[0]).toEqual(['--notify', 'stdout']);
		});

		it('delivers the full current set on subscription', () => {
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStdout(frame(0));

			expect(sets(listener)).toHaveLength(1);
			expect(sets(listener)[0]).toHaveLength(11);
			// The set as the capture found it: the simulator that was booted during the run had
			// not been booted yet.
			expect(sets(listener)[0]?.find((device) => device.serial === TRANSITIONING)?.state).toBe(
				'offline',
			);
		});

		/**
		 * The whole point of moving off the poll: while the stream is healthy, `simctl` is not run
		 * at all — not once per gap, not once ever.
		 */
		it('runs no simctl listing at all while the stream is healthy', async () => {
			answers(listing());

			backend.watchDevices(watcher());
			live().onStdout(frame(0));
			await nextPoll();
			await nextPoll();

			expect(runSimctl).not.toHaveBeenCalled();
		});

		/** Never a delta: every frame is the full set, and a state change is 11 devices again. */
		it('delivers the full set again on every change, never a delta', () => {
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStdout(frame(0));
			live().onStdout(frame(2));

			expect(sets(listener)).toHaveLength(2);
			expect(sets(listener)[1]).toHaveLength(11);
			expect(sets(listener)[1]?.find((device) => device.serial === TRANSITIONING)?.state).toBe(
				'ready',
			);
		});

		it('delivers every frame of one chunk, in order', () => {
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStdout(Buffer.concat([frame(0), frame(2)]));

			expect(sets(listener)).toHaveLength(2);
			expect(sets(listener)[0]?.find((device) => device.serial === TRANSITIONING)?.state).toBe(
				'offline',
			);
			expect(sets(listener)[1]?.find((device) => device.serial === TRANSITIONING)?.state).toBe(
				'ready',
			);
		});

		/**
		 * The companion emits on every change *it* sees, which includes changes this backend's
		 * mapping drops — a physical target, or a field the neutral shape does not carry. One
		 * delivery rule for both sources is what keeps those from waking the host.
		 */
		it('is silent about a frame whose device set did not change', () => {
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStdout(frame(0));
			live().onStdout(frame(0));

			expect(sets(listener)).toHaveLength(1);
		});

		/**
		 * The distinction `onInterrupted` exists to make, on this platform's own worst case: a
		 * companion is a host process nothing else supervises, and `idb file push` crashes one
		 * outright (`docs/IOS.md` §4). Delivered as `[]` it would tell an inventory that every
		 * simulator on the machine had gone away, and every lease over one would be released.
		 */
		it('reports a companion that died as exactly one interruption, and never as an empty set', () => {
			answers(listing());
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStdout(frame(0));
			dies();

			expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
			// No cause: a companion that ended is expected to clear on the restart, which is
			// every end here but one.
			expect(listener.onInterrupted).toHaveBeenCalledWith(expect.any(String), null);
			expect(sets(listener).some((set) => set.length === 0)).toBe(false);
		});

		it('falls back to the poll once the stream is gone, and delivers from it', async () => {
			answers(listing());
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStdout(frame(0));
			dies();
			await settle();

			expect(sets(listener)).toHaveLength(2);
			expect(sets(listener)[1]).toHaveLength(22);
		});

		/**
		 * The companion's own complaint is what explains the end, and this runner hands every byte
		 * of stderr over rather than quoting it back — so the watch is what puts the tail into the
		 * message a person reads, the way `unparseable` does for a query.
		 */
		it('carries what the companion said on stderr into the interruption', () => {
			answers(listing());
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStderr('NIOThrowingAsyncSequenceProducer allows only a single AsyncIterator\n');
			dies('idb_companion --notify stdout was killed by SIGTRAP');

			expect(listener.onInterrupted.mock.calls[0]?.[0]).toContain('was killed by SIGTRAP');
			expect(listener.onInterrupted.mock.calls[0]?.[0]).toContain(
				'stderr: NIOThrowingAsyncSequenceProducer allows only a single AsyncIterator',
			);
		});

		it('quotes an empty stderr rather than leaving the question open', () => {
			answers(listing());
			const listener = watcher();

			backend.watchDevices(listener);
			dies();

			expect(listener.onInterrupted.mock.calls[0]?.[0]).toContain('stderr: (empty)');
		});

		/**
		 * A frame this backend cannot read ends the companion rather than being skipped: framing
		 * that has lost sync cannot be resynchronised, so a device set sliced at a guessed offset
		 * is worse than none. Reported, never thrown — this runs inside a stdout handler, where
		 * there is nothing above it to catch.
		 */
		it('treats a frame it cannot read as a lost view rather than throwing', () => {
			answers(listing());
			const listener = watcher();

			backend.watchDevices(listener);

			expect(() => live().onStdout(Buffer.from('not a frame at all\n'))).not.toThrow();
			expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
			expect(listener.onInterrupted.mock.calls[0]?.[0]).toContain(
				'expected one JSON array of targets per line',
			);
			expect(listener.onDevices).not.toHaveBeenCalled();
			// And the companion is stopped rather than left running: it can only produce more of
			// the same.
			expect(stops[0]).toHaveBeenCalled();
		});

		/**
		 * The one end worth naming a program in (#168). A host with no `idb_companion` will never
		 * grow one on its own, so every surface would otherwise repeat "the host's view was
		 * interrupted" about a host that needs somebody to unpack a tarball. The name is what
		 * makes that actionable without any client knowing what idb is.
		 */
		it('names idb_companion as the cause when this host has none', () => {
			streamIdbCompanion.mockImplementation(() => {
				throw new IdbCompanionNotFoundError([]);
			});
			const listener = watcher();

			backend.watchDevices(listener);

			expect(listener.onInterrupted).toHaveBeenCalledWith(expect.any(String), {
				cause: 'tooling-missing',
				tool: 'idb_companion',
			});
		});

		it('starts no companion at all with a decoder holding a partial frame across a restart', () => {
			const listener = watcher();

			backend.watchDevices(listener);
			live().onStdout(frame(0).subarray(0, 40));
			dies();
			vi.advanceTimersByTime(250);
			live().onStdout(frame(0).subarray(40));

			expect(sets(listener)).toHaveLength(0);
		});

		it('restarts the companion after a bounded wait', () => {
			answers(listing());

			backend.watchDevices(watcher());
			dies();
			expect(streamIdbCompanion).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(250);
			expect(streamIdbCompanion).toHaveBeenCalledTimes(2);
		});

		// A companion that is not there ends as fast as it can be started; a fixed delay there is
		// a busy loop with a process spawn in it.
		it('backs off, up to a ceiling, while every restart keeps failing', () => {
			answers(listing());

			backend.watchDevices(watcher());

			for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) {
				dies();
				vi.advanceTimersByTime(delay - 1);
				const started = streamIdbCompanion.mock.calls.length;
				vi.advanceTimersByTime(1);
				expect(streamIdbCompanion.mock.calls.length).toBe(started + 1);
			}
		});

		it('goes back to the short wait once a companion delivered a frame', () => {
			answers(listing());

			backend.watchDevices(watcher());
			dies();
			vi.advanceTimersByTime(250);
			dies();
			vi.advanceTimersByTime(500);
			// The third companion works, so the fourth restart is a first failure again.
			live().onStdout(frame(0));
			dies();

			vi.advanceTimersByTime(250);
			expect(streamIdbCompanion).toHaveBeenCalledTimes(4);
		});

		/**
		 * The handover back, which is the other half of "only one source delivers at a time": a
		 * frame is what proves the stream is healthy again, so it is what takes the watch off the
		 * poll — and no interruption is reported, because nothing was lost.
		 */
		it('takes the watch back off the poll when the stream returns', async () => {
			answers(listing());
			const listener = watcher();

			backend.watchDevices(listener);
			dies();
			await settle();
			expect(sets(listener)[0]).toHaveLength(22);

			await vi.advanceTimersByTimeAsync(250);
			live().onStdout(frame(0));
			expect(sets(listener)[1]).toHaveLength(11);

			runSimctl.mockClear();
			await nextPoll();
			await nextPoll();
			expect(runSimctl).not.toHaveBeenCalled();
			expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
		});

		/**
		 * The view is whichever source is serving the caller, so the fallback costs one
		 * interruption and not one per attempt: once the poll is delivering, a companion that
		 * fails to start again changes nothing the caller can observe.
		 */
		it('is silent about a restart that fails while the poll is delivering', async () => {
			answers(listing());
			const listener = watcher();

			backend.watchDevices(listener);
			dies();
			await settle();
			expect(listener.onInterrupted).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(250);
			dies();
			await vi.advanceTimersByTimeAsync(500);
			dies();

			expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
		});

		it('delivers nothing at all when it is stopped before the first frame', async () => {
			const listener = watcher();

			const watch = backend.watchDevices(listener);
			await watch.stop();

			expect(listener.onDevices).not.toHaveBeenCalled();
			expect(listener.onInterrupted).not.toHaveBeenCalled();
			expect(stops[0]).toHaveBeenCalledTimes(1);
		});

		it('stops the companion and never restarts it once stopped', async () => {
			const listener = watcher();
			const watch = backend.watchDevices(listener);
			live().onStdout(frame(0));

			await watch.stop();
			listener.onDevices.mockClear();
			live().onStdout(frame(2));
			dies();
			vi.advanceTimersByTime(60_000);

			expect(stops[0]).toHaveBeenCalledTimes(1);
			expect(streamIdbCompanion).toHaveBeenCalledTimes(1);
			expect(listener.onDevices).not.toHaveBeenCalled();
			expect(listener.onInterrupted).not.toHaveBeenCalled();
		});

		it('cancels a restart that was already scheduled', async () => {
			answers(listing());
			const watch = backend.watchDevices(watcher());

			dies();
			await watch.stop();
			vi.advanceTimersByTime(60_000);

			expect(streamIdbCompanion).toHaveBeenCalledTimes(1);
		});
	});

	/**
	 * The poll, on a host with no `idb_companion` at all — the fallback, doing the whole job.
	 *
	 * Every case here subscribes through {@link watchPolling}, which absorbs the one interruption
	 * the missing companion produces so that each case reads as the poll's own claim. That
	 * interruption is asserted on its own by the stream suite above.
	 */
	describe('falling back to the simctl poll', () => {
		beforeEach(() => {
			streamIdbCompanion.mockImplementation(() => {
				throw new IdbCompanionNotFoundError([]);
			});
		});

		function watchPolling(listener: ReturnType<typeof watcher>): DeviceWatch {
			const watch = backend.watchDevices(listener);
			expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
			listener.onInterrupted.mockClear();
			return watch;
		}

		it('starts as soon as it is asked to, with the enumeration’s own argv', async () => {
			answers(listing());

			watchPolling(watcher());
			await settle();

			expect(runSimctl).toHaveBeenCalledTimes(1);
			expect(runSimctl.mock.calls[0]?.[0]).toEqual(ENUMERATE);
		});

		it('delivers the full current set on subscription', async () => {
			answers(listing());
			const listener = watcher();

			watchPolling(listener);
			await settle();

			expect(sets(listener)).toHaveLength(1);
			expect(sets(listener)[0]).toHaveLength(22);
			expect(sets(listener)[0]?.find((device) => device.serial === BOOTED)?.state).toBe('ready');
		});

		it('delivers nothing when the next poll finds the same device set', async () => {
			answers(listing());
			const listener = watcher();

			watchPolling(listener);
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

			watchPolling(listener);
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

			watchPolling(listener);
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

			watchPolling(listener);
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

			watchPolling(listener);
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

			watchPolling(listener);
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
		 * The distinction #168 exists to make, on the fallback's own tooling: a failure that will
		 * clear on its own and one that never will read identically on every surface unless the
		 * backend says which it is. There being no `simctl` to run is the second kind — a Command
		 * Line Tools selection does not start carrying one — and the program's name is what makes a
		 * client's message actionable without the client knowing anything about Xcode.
		 */
		it('names simctl as the cause when there was none to run', async () => {
			runSimctl.mockRejectedValue(new SimctlNotFoundError([]));
			const listener = watcher();

			watchPolling(listener);
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

			watchPolling(watcher());
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

			watchPolling(listener);
			await settle();
			expect(sets(listener)).toHaveLength(1);

			runSimctl.mockRejectedValueOnce(new Error('simctl list -j devices runtimes exited 1'));
			await nextPoll();
			answers(listing());
			await nextPoll();

			expect(sets(listener)).toHaveLength(2);
			expect(sets(listener)[1]).toEqual(sets(listener)[0]);
		});

		/**
		 * Synchronous and never rejecting: the missing companion is known before the call returns,
		 * because that search is `stat` and `access` and no process — while the first poll is
		 * started rather than awaited, so its failure arrives through the listener like every later
		 * one rather than as a rejection nothing is written to catch.
		 */
		it('answers with its handle synchronously, even when the first poll fails', async () => {
			runSimctl.mockRejectedValue(new Error('simctl list -j devices runtimes exited 1'));
			const listener = watcher();

			const watch = backend.watchDevices(listener);

			expect(typeof watch.stop).toBe('function');
			expect(listener.onInterrupted).toHaveBeenCalledTimes(1);
			await settle();
			expect(listener.onInterrupted).toHaveBeenCalledTimes(2);
		});

		it('stops polling and calls no handler after stop', async () => {
			answers(listing());
			const listener = watcher();

			const watch = watchPolling(listener);
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

			const watch = watchPolling(listener);
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

			const watch = watchPolling(listener);
			await watch.stop();
			fail(new Error('simctl list -j devices runtimes exited 1'));
			await settle();

			expect(listener.onInterrupted).not.toHaveBeenCalled();
		});

		it('treats a second stop as a no-op rather than an error', async () => {
			answers(listing());

			const watch = watchPolling(watcher());
			await settle();

			await expect(watch.stop()).resolves.toBeUndefined();
			await expect(watch.stop()).resolves.toBeUndefined();
		});
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
 * The app lifecycle, with the process replaced and the wording predicates real.
 *
 * Every one of these methods addresses a device, so every one of them has to go through
 * `runSimctlOnDevice` — the runner that cannot be handed `booted` by accident. Asserting the
 * subcommand and its arguments there rather than a flat argv is what pins that.
 */
describe('the app lifecycle', () => {
	const APP: AppId = parseAppId('com.rover.testapp');

	/** `simctl terminate` on an app that is not running, captured from this repository's bench. */
	const NOT_RUNNING = readFileSync(
		fixtureUrl('simctl-terminate-not-running.xcode26.4.1-ios26.4.1.txt'),
		'utf8',
	);
	/** The same subcommand refusing for a real reason: the device is not booted. */
	const SHUTDOWN = readFileSync(
		fixtureUrl('simctl-terminate-shutdown.xcode26.4.1-ios26.4.1.txt'),
		'utf8',
	);

	describe('installApp', () => {
		it('installs the host path, pinned to the device, with the install budget', async () => {
			await backend.installApp(BOOTED, '/var/folders/qx/T/rover-transfer-a1/payload');

			expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
			expect(runSimctlOnDevice.mock.calls[0]?.slice(0, 3)).toEqual([
				BOOTED,
				'install',
				['/var/folders/qx/T/rover-transfer-a1/payload'],
			]);
			expect(runSimctlOnDevice.mock.calls[0]?.[3]?.timeoutMs).toBe(INSTALL_SIMCTL_TIMEOUT_MS);
		});

		/**
		 * The path is the daemon's own temporary file, deleted moments later, and this message is
		 * read on the agent's machine (D19) — so it is named for redaction rather than left in.
		 */
		it('names the host path for redaction out of the failure message', async () => {
			await backend.installApp(BOOTED, '/var/folders/qx/T/rover-transfer-a1/payload');

			expect(runSimctlOnDevice.mock.calls[0]?.[3]?.redactArgv).toEqual([
				'/var/folders/qx/T/rover-transfer-a1/payload',
			]);
		});

		// No wording is asserted on the way out, so the exit code the runner threw on is the whole
		// of the check and the tool's own words reach the caller intact.
		it('lets the runner’s failure through', async () => {
			runSimctlOnDevice.mockRejectedValueOnce(refusedWith(2, 'lstat of … failed'));

			await expect(backend.installApp(BOOTED, '/tmp/nope.app')).rejects.toThrow('exited 2');
		});
	});

	describe('launchApp', () => {
		it('launches the bundle identifier, pinned to the device', async () => {
			runSimctlOnDevice.mockResolvedValueOnce({ stdout: 'com.rover.testapp: 23205\n', stderr: '' });

			await backend.launchApp(BOOTED, APP);

			expect(runSimctlOnDevice.mock.calls[0]?.slice(0, 3)).toEqual([
				BOOTED,
				'launch',
				['com.rover.testapp'],
			]);
		});

		it('fails when the tool did', async () => {
			runSimctlOnDevice.mockRejectedValueOnce(
				refusedWith(4, 'Simulator device failed to launch com.rover.testapp.'),
			);

			await expect(backend.launchApp(BOOTED, APP)).rejects.toThrow('exited 4');
		});
	});

	describe('stopApp', () => {
		it('terminates the bundle identifier, pinned to the device', async () => {
			await backend.stopApp(BOOTED, APP);

			expect(runSimctlOnDevice.mock.calls[0]?.slice(0, 3)).toEqual([
				BOOTED,
				'terminate',
				['com.rover.testapp'],
			]);
		});

		/**
		 * The decision this method exists to make: an app that was not running is already in the
		 * state the caller asked for. Read off the **captured** wording, and deliberately not off
		 * the exit code, which is one of three unrelated numbers this tool answers with.
		 */
		it('counts “found nothing to terminate” as done', async () => {
			runSimctlOnDevice.mockRejectedValueOnce(refusedWith(3, NOT_RUNNING));

			await expect(backend.stopApp(BOOTED, APP)).resolves.toBeUndefined();
		});

		it('still fails when the terminate failed for any other reason', async () => {
			runSimctlOnDevice.mockRejectedValueOnce(refusedWith(149, SHUTDOWN));

			await expect(backend.stopApp(BOOTED, APP)).rejects.toThrow(
				'Unable to lookup in current state: Shutdown',
			);
		});

		// The wording is only ever read off a `SimctlCommandError`: anything else reaching here is
		// a bug in this process rather than an answer from the tool, and swallowing one would hide
		// it behind a verb that reported success.
		it('rethrows a failure that did not come from the tool', async () => {
			runSimctlOnDevice.mockRejectedValueOnce(new Error('found nothing to terminate'));

			await expect(backend.stopApp(BOOTED, APP)).rejects.toThrow('found nothing to terminate');
		});
	});

	describe('clearAppData', () => {
		/** Where `get_app_container … app` says the installed bundle is — inside the device. */
		let installedBundle: string;
		/** The `mkdtemp` standing in for that device's storage, removed after each case. */
		let deviceStorage: string;

		afterEach(async () => {
			await rm(deviceStorage, { recursive: true, force: true });
		});

		beforeEach(async () => {
			deviceStorage = await mkdtemp(join(tmpdir(), 'rover-installed-'));
			installedBundle = join(
				deviceStorage,
				'Containers',
				'Bundle',
				'Application',
				'F12C753E',
				'Rover.app',
			);
			await mkdir(installedBundle, { recursive: true });
			await writeFile(join(installedBundle, 'Info.plist'), 'bundle contents');

			runSimctlOnDevice.mockImplementation(async (_serial, subcommand) => ({
				stdout: subcommand === 'get_app_container' ? `${installedBundle}\n` : '',
				stderr: '',
			}));
		});

		it('resolves the installed bundle, then uninstalls and installs it back', async () => {
			await backend.clearAppData(BOOTED, APP);

			expect(runSimctlOnDevice.mock.calls.map((call) => [call[1], call[2]?.[0]])).toEqual([
				['get_app_container', 'com.rover.testapp'],
				['uninstall', 'com.rover.testapp'],
				['install', expect.stringContaining('Rover.app')],
			]);
			expect(runSimctlOnDevice.mock.calls.every((call) => call[0] === BOOTED)).toBe(true);
		});

		/**
		 * The ordering that makes the method work at all, asserted by **doing what the uninstall
		 * does**: the path `get_app_container` prints is inside the storage it removes, verified
		 * against a simulator, so the mock below deletes the bundle when the uninstall is called.
		 * An implementation that copied afterwards would have nothing left to copy. The staged
		 * copy also keeps the `.app` basename `simctl install` insists on for a directory.
		 */
		it('copies the bundle off the device before the uninstall removes it', async () => {
			let installedFrom = '';
			let installedContents = '';
			runSimctlOnDevice.mockImplementation(async (_serial, subcommand, args) => {
				if (subcommand === 'uninstall') await rm(installedBundle, { recursive: true, force: true });
				if (subcommand === 'install') {
					installedFrom = args?.[0] ?? '';
					installedContents = await readFile(join(installedFrom, 'Info.plist'), 'utf8');
				}
				return {
					stdout: subcommand === 'get_app_container' ? `${installedBundle}\n` : '',
					stderr: '',
				};
			});

			await backend.clearAppData(BOOTED, APP);

			expect(installedContents).toBe('bundle contents');
			expect(installedFrom).not.toBe(installedBundle);
			expect(installedFrom.endsWith('/Rover.app')).toBe(true);
			expect(installedFrom).toContain('rover-ios-clear-');
		});

		it('removes its staging directory however the call ended', async () => {
			let stagingRoot = '';
			runSimctlOnDevice.mockImplementation(async (_serial, subcommand, args) => {
				if (subcommand === 'install') stagingRoot = dirname(args?.[0] ?? '');
				if (subcommand === 'install') throw refusedWith(1, 'App installation failed');
				return {
					stdout: subcommand === 'get_app_container' ? `${installedBundle}\n` : '',
					stderr: '',
				};
			});

			await expect(backend.clearAppData(BOOTED, APP)).rejects.toThrow(/is \*\*not\*\* installed/);

			await expect(stat(stagingRoot)).rejects.toThrow();
		});

		/**
		 * The one window this route has: after the uninstall the app is gone, and the staged copy
		 * goes with the scratch directory. `simctl install … exited 1` on its own reads as though
		 * nothing had happened, so the answer names the state it left and carries the tool's own
		 * message as the `cause` for this host's log.
		 */
		it('says the app is uninstalled when the reinstall fails, with the tool as the cause', async () => {
			runSimctlOnDevice.mockImplementation(async (_serial, subcommand) => {
				if (subcommand === 'install') throw refusedWith(1, 'App installation failed');
				return {
					stdout: subcommand === 'get_app_container' ? `${installedBundle}\n` : '',
					stderr: '',
				};
			});

			const rejection = backend.clearAppData(BOOTED, APP);

			await expect(rejection).rejects.toThrow(/was uninstalled from device/);
			await expect(rejection).rejects.toThrow('com.rover.testapp');
			await expect(rejection).rejects.toThrow(/nothing here to retry from/);
			await expect(rejection).rejects.toMatchObject({
				cause: expect.objectContaining({ message: expect.stringContaining('exited 1') }),
			});
		});

		/**
		 * The one exit-0 answer the reinstall cannot be built on. An empty path would make the
		 * staged copy the scratch directory itself and the uninstall would run with nothing behind
		 * it, so it is refused before anything is removed rather than discovered afterwards.
		 */
		it('refuses when the container lookup succeeded without naming a bundle', async () => {
			runSimctlOnDevice.mockResolvedValue({ stdout: '\n', stderr: '' });

			await expect(backend.clearAppData(BOOTED, APP)).rejects.toThrow(/without naming a bundle/);
			expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
		});

		// An app that is not installed fails at the first call, and nothing has been touched by
		// then — the same shape `pm clear` gives for a package that does not exist.
		it('does not uninstall anything when the app is not installed', async () => {
			runSimctlOnDevice.mockRejectedValueOnce(refusedWith(2, 'No such file or directory'));

			await expect(backend.clearAppData(BOOTED, APP)).rejects.toThrow('exited 2');
			expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
		});
	});
});

/**
 * The two transfers, against a data root of this suite's own.
 *
 * There is no process in either of them — a simulator's storage *is* a host path — so what is
 * mocked is the one listing they read `dataPath` out of, and everything after that is real
 * `node:fs` against a `mkdtemp` directory. That is the honest shape here: stubbing the filesystem
 * would leave the confinement asserted against a stub of the thing it protects.
 */
describe('the two transfers', () => {
	let scratch: string;
	let dataRoot: string;
	/** Somewhere outside the root, standing in for the rest of the machine lending the device. */
	let outside: string;

	afterEach(async () => {
		await rm(scratch, { recursive: true, force: true });
	});

	/** The capture with the subject device's `dataPath` pointed at this suite's own directory. */
	const rooted = (): string =>
		listing((parsed) => {
			entryOf(parsed, BOOTED).dataPath = dataRoot;
		});

	beforeEach(async () => {
		scratch = await mkdtemp(join(tmpdir(), 'rover-ios-transfer-'));
		dataRoot = join(scratch, 'data');
		outside = join(scratch, 'elsewhere');
		await mkdir(join(dataRoot, 'Documents'), { recursive: true });
		await mkdir(outside, { recursive: true });
		answers(rooted());
	});

	describe('pushFile', () => {
		it('copies the host file to where the device path names, under the data root', async () => {
			const source = join(outside, 'payload');
			await writeFile(source, 'the bytes');

			await backend.pushFile(BOOTED, source, '/Documents/report.bin');

			expect(await readFile(join(dataRoot, 'Documents', 'report.bin'), 'utf8')).toBe('the bytes');
		});

		it('reads the data root off the device listing, and asks for that listing alone', async () => {
			const source = join(outside, 'payload');
			await writeFile(source, 'x');

			await backend.pushFile(BOOTED, source, '/Documents/report.bin');

			expect(runSimctl).toHaveBeenCalledTimes(1);
			expect(runSimctl.mock.calls[0]?.[0]).toEqual(['list', '-j', 'devices']);
			// Nothing about a transfer goes near the tool: no subcommand was run on the device.
			expect(runSimctlOnDevice).not.toHaveBeenCalled();
		});

		// A container the app has not written to yet has no `Documents/reports/`, and there is no
		// verb in this vocabulary that would make one.
		it('creates the directories the destination needs', async () => {
			const source = join(outside, 'payload');
			await writeFile(source, 'nested');

			await backend.pushFile(BOOTED, source, '/Documents/reports/2026/report.bin');

			expect(
				await readFile(join(dataRoot, 'Documents', 'reports', '2026', 'report.bin'), 'utf8'),
			).toBe('nested');
		});

		it('overwrites a file that is already there, which is what the caller asked for', async () => {
			const source = join(outside, 'payload');
			await writeFile(source, 'new');
			await writeFile(join(dataRoot, 'Documents', 'report.bin'), 'old');

			await backend.pushFile(BOOTED, source, '/Documents/report.bin');

			expect(await readFile(join(dataRoot, 'Documents', 'report.bin'), 'utf8')).toBe('new');
		});

		/**
		 * The contract's own rule (`DeviceBackend.pushFile`), and it has to be a rule here rather
		 * than a device answer: `copyFile` would fail with `EISDIR` and a host path, telling the
		 * caller about this machine instead of about the thing it got wrong.
		 */
		it('refuses a destination that is already a directory', async () => {
			const source = join(outside, 'payload');
			await writeFile(source, 'x');

			await expect(backend.pushFile(BOOTED, source, '/Documents')).rejects.toThrow(
				/is a directory on device/,
			);
			expect(await readdir(join(dataRoot, 'Documents'))).toEqual([]);
		});

		/**
		 * The confinement, on the side where it is a **write**: an unconfined join here is a
		 * remote write anywhere this host's user can write. Asserted as "nothing moved" and not
		 * only as a throw, because the throw would be worth little if the copy had happened first.
		 */
		it('refuses a path that climbs out of the data root, before anything moves', async () => {
			const source = join(outside, 'payload');
			await writeFile(source, 'x');

			await expect(
				backend.pushFile(BOOTED, source, '/Documents/../../elsewhere/stolen'),
			).rejects.toThrow(/resolves outside the storage/);
			expect(await readdir(outside)).toEqual(['payload']);
		});

		/**
		 * The write-side mirror of the pull's "naming no path on this host": `mkdir` refuses when
		 * one of the names on the way to the destination is a regular file, and `node:fs` puts the
		 * whole host path in that message — the operator's home directory and this host's
		 * CoreSimulator layout, to a caller that only ever named `/Documents/…` (D19).
		 */
		it('refuses a destination under an existing file, naming no path on this host', async () => {
			const source = join(outside, 'payload');
			await writeFile(source, 'x');
			await writeFile(join(dataRoot, 'Documents', 'report.bin'), 'a file, not a directory');

			const rejection = backend.pushFile(BOOTED, source, '/Documents/report.bin/nested.txt');

			await expect(rejection).rejects.toThrow("'/Documents/report.bin/nested.txt'");
			await expect(rejection).rejects.toThrow('997FA43E-FF9F-4109-BEF0-53D3F46653E7');
			await expect(rejection).rejects.not.toThrow(new RegExp(dataRoot));
		});

		// The other half of the same rule: the source is the daemon's own staged payload, so its
		// path is no more the caller's to read than the data root is.
		it('carries the errno but neither path when the host file to push is gone', async () => {
			const rejection = backend.pushFile(BOOTED, join(outside, 'never-staged'), '/Documents/x.bin');

			await expect(rejection).rejects.toThrow('ENOENT');
			await expect(rejection).rejects.toThrow("'/Documents/x.bin'");
			await expect(rejection).rejects.not.toThrow(new RegExp(outside));
			await expect(rejection).rejects.not.toThrow(new RegExp(dataRoot));
		});

		// The listing doubles as the presence check, so a device that has been deleted is the
		// contract's own error rather than an `ENOENT` about a directory on this host.
		it('reports a device the listing no longer names as vanished', async () => {
			answers(withoutDevice(BOOTED));
			const source = join(outside, 'payload');
			await writeFile(source, 'x');

			await expect(backend.pushFile(BOOTED, source, '/Documents/report.bin')).rejects.toThrow(
				DeviceVanishedError,
			);
		});
	});

	describe('pullFile', () => {
		const NO_BOUND = { maxBytes: 1024 * 1024 };

		it('answers with the bytes of the file, never with a path', async () => {
			await writeFile(join(dataRoot, 'Documents', 'report.bin'), 'the bytes');

			const bytes = await backend.pullFile(BOOTED, '/Documents/report.bin', NO_BOUND);

			expect(Buffer.from(bytes).toString('utf8')).toBe('the bytes');
		});

		it('answers an empty file with no bytes rather than with a failure', async () => {
			await writeFile(join(dataRoot, 'Documents', 'empty.bin'), '');

			expect(await backend.pullFile(BOOTED, '/Documents/empty.bin', NO_BOUND)).toHaveLength(0);
		});

		/**
		 * A directory's own size says nothing about the tree under it, so a bound taken on the
		 * reported number would admit an unbounded read. Refused by shape instead.
		 */
		it('refuses a source that is not one regular file', async () => {
			await expect(backend.pullFile(BOOTED, '/Documents', NO_BOUND)).rejects.toThrow(
				/is a directory, and a pull answers with the bytes of one regular file/,
			);
		});

		it('refuses a file over the bound before reading it', async () => {
			await writeFile(join(dataRoot, 'Documents', 'big.bin'), 'x'.repeat(64));

			await expect(
				backend.pullFile(BOOTED, '/Documents/big.bin', { maxBytes: 32 }),
			).rejects.toThrow(FileTooLargeError);
		});

		/**
		 * A missing file is a throw rather than an empty answer — an empty array is
		 * indistinguishable from an empty file that really is there — and the message carries the
		 * errno rather than the path, because it is read on the agent's machine (D19).
		 */
		it('throws for a file that is not there, naming no path on this host', async () => {
			const rejection = backend.pullFile(BOOTED, '/Documents/gone.bin', NO_BOUND);

			await expect(rejection).rejects.toThrow('ENOENT');
			await expect(rejection).rejects.toThrow("'/Documents/gone.bin'");
			await expect(rejection).rejects.not.toThrow(new RegExp(dataRoot));
		});

		it('refuses a path that climbs out of the data root', async () => {
			await writeFile(join(outside, 'secret'), 'not yours');

			await expect(
				backend.pullFile(BOOTED, '/Documents/../../elsewhere/secret', NO_BOUND),
			).rejects.toThrow(/resolves outside the storage/);
		});

		it('reports a device the listing no longer names as vanished', async () => {
			answers(withoutDevice(BOOTED));

			await expect(backend.pullFile(BOOTED, '/Documents/report.bin', NO_BOUND)).rejects.toThrow(
				DeviceVanishedError,
			);
		});
	});
});

/**
 * The capture, with the *tool* replaced and the filesystem real: the mock writes where it was
 * told to write, which is the only way the staging, the read-back and the cleanup are assertable
 * without a simulator. What no mock can answer — that a simulator answers this argv at all, and
 * that a device which is not booted is refused in milliseconds rather than after a minute — is
 * `tests/device/ios-simulator/screenshot.test.ts`.
 */
describe('screenshot', () => {
	/** Enough of a PNG to pass the sniff: the signature and the first bytes of an IHDR. */
	const PNG = Uint8Array.from([...PNG_SIGNATURE, 0x00, 0x00, 0x00, 0x0d]);

	/** What the tool says on the success path, on the stream it really says it on. */
	const WROTE = (at: string): { stdout: string; stderr: string } => ({
		stdout: '',
		stderr: `Note: No display specified. Defaulting to display: …\nWrote screenshot to: ${at}\n`,
	});

	/** The staged path of the one capture that was asked for. */
	const stagedPath = (): string => runSimctlOnDevice.mock.calls[0]?.[2]?.at(-1) ?? '';

	/** `simctl`, writing `bytes` where it was told to write them. */
	function writes(bytes: Uint8Array | null): void {
		runSimctlOnDevice.mockImplementation(async (_serial, _subcommand, args) => {
			const at = args?.at(-1) ?? '';
			if (bytes !== null) await writeFile(at, bytes);
			return WROTE(at);
		});
	}

	beforeEach(() => {
		answers(listing());
		writes(PNG);
	});

	it('captures to a staged file and answers with the bytes, never with a path', async () => {
		const bytes = await backend.screenshot(BOOTED);

		expect(Buffer.from(bytes).equals(Buffer.from(PNG))).toBe(true);
		expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
		expect(runSimctlOnDevice.mock.calls[0]?.slice(0, 2)).toEqual([BOOTED, 'io']);
		expect(runSimctlOnDevice.mock.calls[0]?.[2]).toEqual([
			'screenshot',
			'--type',
			'png',
			'--mask',
			'ignored',
			stagedPath(),
		]);
	});

	it('bounds the capture and masks the staged path out of a failure message', async () => {
		await backend.screenshot(BOOTED);

		expect(runSimctlOnDevice.mock.calls[0]?.[3]?.timeoutMs).toBe(SCREENSHOT_SIMCTL_TIMEOUT_MS);
		expect(runSimctlOnDevice.mock.calls[0]?.[3]?.redactArgv).toEqual([stagedPath()]);
	});

	/**
	 * Measured rather than tidiness: the tool resolves the destination against a directory this
	 * process does not choose, and a relative path fails with the same *read-only volume* error
	 * that `-` does (`docs/IOS.md` §8, trap 10).
	 */
	it('stages an absolute path of its own, attributable to this backend', async () => {
		await backend.screenshot(BOOTED);

		expect(isAbsolute(stagedPath())).toBe(true);
		expect(stagedPath()).toContain('rover-ios-screenshot-');
	});

	it('removes the staged capture on the way out', async () => {
		await backend.screenshot(BOOTED);

		await expect(stat(dirname(stagedPath()))).rejects.toThrow();
	});

	it('removes it when the capture failed too', async () => {
		runSimctlOnDevice.mockImplementation(async (_serial, _subcommand, args) => {
			await writeFile(args?.at(-1) ?? '', PNG);
			throw refusedWith(1, 'Timeout waiting for screen surfaces');
		});

		await expect(backend.screenshot(BOOTED)).rejects.toThrow('exited 1');
		await expect(stat(dirname(stagedPath()))).rejects.toThrow();
	});

	/**
	 * The criterion this phase exists for: against a device that is not booted the capture blocks
	 * for a minute and then fails, so the state is read **first** and nothing is run
	 * (`docs/IOS.md` §8, trap 1). The refusal names the device and the state, in the neutral
	 * vocabulary `devices.ts` maps the tool's own onto.
	 */
	it('refuses a device that is not booted without running the capture', async () => {
		const rejection = backend.screenshot(IPHONE_17_PRO);

		await expect(rejection).rejects.toThrow(`'${IPHONE_17_PRO}' is 'offline' rather than ready`);
		await expect(rejection).rejects.toThrow(/nothing was captured and nothing was run/);
		expect(runSimctlOnDevice).not.toHaveBeenCalled();
		expect(runSimctl).toHaveBeenCalledTimes(1);
	});

	// The contract's own distinction from `describeDevice`'s `null`: a device that is not there at
	// all is not a device in the wrong state.
	it('reports a device the listing no longer names as vanished', async () => {
		await expect(backend.screenshot(GONE)).rejects.toBeInstanceOf(DeviceVanishedError);
		expect(runSimctlOnDevice).not.toHaveBeenCalled();
	});

	it('refuses bytes that are not a PNG, describing them rather than quoting them', async () => {
		writes(new TextEncoder().encode('not an image'));

		const rejection = backend.screenshot(BOOTED);

		await expect(rejection).rejects.toThrow(
			/is not a PNG \(12 bytes, starting 6e 6f 74 20 61 6e 20 69\)/,
		);
		await expect(rejection).rejects.toThrow(String(BOOTED));
	});

	/**
	 * An exit-0 answer this method cannot be built on. No such run has been captured — every one
	 * printed `Wrote screenshot to: …` and produced the file — so what is asserted is that the
	 * failure says what happened and carries the errno instead of a host path (D19).
	 */
	it('says so when the tool exited 0 without writing the capture', async () => {
		writes(null);

		const rejection = backend.screenshot(BOOTED);

		await expect(rejection).rejects.toThrow(/could not be read back \(ENOENT\)/);
		await expect(rejection).rejects.toThrow(/simctl exited 0/);
		await expect(rejection).rejects.not.toThrow(/rover-ios-screenshot-/);
	});

	it('lets the runner’s own failure through', async () => {
		runSimctlOnDevice.mockRejectedValue(refusedWith(60, 'Timeout waiting for screen surfaces'));

		await expect(backend.screenshot(BOOTED)).rejects.toThrow('exited 60');
	});
});

/**
 * The screen read as the **join**: the state check, the call, the mapping.
 *
 * The payload handed back is a real capture and the parsing and mapping under it are real
 * (`parsers/accessibility.test.ts`, `screen.test.ts` are where those are argued); the transport is
 * the stub, so nothing here starts a companion or needs idb. `tests/device/ios-simulator/` is
 * where a real screen is read.
 */
describe('readScreen', () => {
	/** Safari's start page, captured through this repository's own client. */
	const CAPTURED_READ = readFileSync(
		fixtureUrl('accessibility.uikit-textfield.idbcompanion1.5.2-xcode26.4.1-ios26.4.1.json'),
		'utf8',
	);

	beforeEach(() => {
		answers(listing());
		companionCall.mockResolvedValue({ json: CAPTURED_READ });
	});

	it('answers the captured read as neutral elements, in the order the tool listed them', async () => {
		const elements = await backend.readScreen(BOOTED);

		expect(elements).toHaveLength(18);
		expect(elements[15]).toEqual({
			id: '15',
			label: 'Adres',
			text: 'Szukaj lub podaj witrynę',
			bounds: {
				x: 136.66666666666666,
				y: 806,
				width: 131.99999999999997,
				height: 20.33333333333337,
			},
		});
	});

	/**
	 * The whole screen, in the flat format, through the companion for **this** device: an
	 * unpinned read would be somebody else's screen, and the format is the one the projection is
	 * the shape of.
	 */
	it('asks that device for the whole screen in the flat format', async () => {
		await backend.readScreen(BOOTED);

		expect(companionCall).toHaveBeenCalledTimes(1);
		expect(companionCall).toHaveBeenCalledWith(BOOTED, 'accessibility_info', {
			format: 'LEGACY',
		});
	});

	/**
	 * A device that is not booted is refused **before** a companion is started, and that is the
	 * point of the check rather than a formality: the tool refuses this one properly, in 13 ms,
	 * so what the check buys is not an answer but a process that never starts (`notReadable`).
	 */
	it('refuses a device that is not booted without reaching for a companion', async () => {
		await expect(backend.readScreen(IPHONE_17_PRO)).rejects.toThrow(/'offline' rather than ready/);

		expect(companionCall).not.toHaveBeenCalled();
	});

	/** And a device the enumeration no longer names is the contract's own vanishing, not a state. */
	it('reports a device that has gone as vanished, without reaching for a companion', async () => {
		await expect(backend.readScreen(GONE)).rejects.toThrow(DeviceVanishedError);

		expect(companionCall).not.toHaveBeenCalled();
	});

	/**
	 * A companion that died is an **interruption**, and it reaches the caller as itself. Turning
	 * one into a device error would take a working simulator out of the inventory over a process
	 * this host is supposed to supervise (`idb-client.ts`).
	 */
	it('lets a companion interruption through as itself', async () => {
		companionCall.mockRejectedValue(new IdbCompanionInterruptedError(unwrap(BOOTED), null, 'died'));

		await expect(backend.readScreen(BOOTED)).rejects.toBeInstanceOf(IdbCompanionInterruptedError);
	});

	/** A payload this projection has not seen is refused rather than mined for what it can find. */
	it('refuses an answer that is not the flat read', async () => {
		companionCall.mockResolvedValue({ json: '{"elements":[]}' });

		await expect(backend.readScreen(BOOTED)).rejects.toThrow(/expected one flat JSON array/);
	});

	/** The one lifecycle method this backend has of its own, and the suites are what call it. */
	it('stops every companion it started when asked to', async () => {
		await backend.stopIdbCompanions();

		expect(companionStopAll).toHaveBeenCalledTimes(1);
	});
});

/**
 * The four injections at the join: the state check in front of each, the events each is turned
 * into, and the two keys this platform refuses.
 *
 * What the events *are* is `./input.test.ts`'s subject and is not re-asserted here — these cases
 * check that the right builder is reached and that nothing reaches the transport it should not.
 * What a device does with any of it is `tests/device/ios-simulator/input.test.ts`', because on
 * this transport a call answering proves nothing: `hid` answers an empty message for a keycode
 * that does not exist.
 */
describe('the input primitives', () => {
	beforeEach(() => {
		answers(listing());
		companionStream.mockResolvedValue(undefined);
	});

	/** Every event of every injection goes through one client-streaming RPC on that device. */
	it('taps through the hid stream, in points, on the device it was asked about', async () => {
		await backend.tap(BOOTED, { x: 201.5, y: 437 });

		expect(companionStream).toHaveBeenCalledTimes(1);
		expect(companionStream).toHaveBeenCalledWith(BOOTED, 'hid', [
			{ press: { action: { touch: { point: { x: 201.5, y: 437 } } }, direction: 'DOWN' } },
			{ press: { action: { touch: { point: { x: 201.5, y: 437 } } }, direction: 'UP' } },
		]);
	});

	it('swipes as one event, with the duration in seconds', async () => {
		await backend.swipe(BOOTED, { x: 2, y: 450 }, { x: 300, y: 450 }, 300);

		expect(companionStream).toHaveBeenCalledWith(BOOTED, 'hid', [
			{ swipe: { start: { x: 2, y: 450 }, end: { x: 300, y: 450 }, duration: 0.3 } },
		]);
	});

	it('types the whole string in one stream', async () => {
		await backend.typeText(BOOTED, 'ab');

		expect(companionStream).toHaveBeenCalledTimes(1);
		expect(companionStream).toHaveBeenCalledWith(BOOTED, 'hid', [
			{ press: { action: { key: { keycode: 4 } }, direction: 'DOWN' } },
			{ press: { action: { key: { keycode: 4 } }, direction: 'UP' } },
			{ press: { action: { key: { keycode: 5 } }, direction: 'DOWN' } },
			{ press: { action: { key: { keycode: 5 } }, direction: 'UP' } },
		]);
	});

	/**
	 * **A programmer error costs no round trip and reads as itself.** The events are built before
	 * the device is looked at, so a `NaN` coordinate never becomes a device enumeration and a
	 * refusal about a state.
	 */
	it.each([
		['tap', () => backend.tap(BOOTED, { x: Number.NaN, y: 1 })],
		['swipe', () => backend.swipe(BOOTED, { x: 1, y: 1 }, { x: 2, y: 2 }, -1)],
	])('refuses a %s it cannot build without asking the device anything', async (_what, inject) => {
		await expect(inject()).rejects.toThrow();

		expect(runSimctl).not.toHaveBeenCalled();
		expect(companionStream).not.toHaveBeenCalled();
	});

	/**
	 * Text the device has no key for is an `UnsupportedTextError` rather than a plain one, because
	 * it is a caller's string that is wrong rather than the host: `src/verbs/failure.ts` carries it
	 * as `unsupported-text` naming the characters to change, where a plain `Error` would arrive as
	 * `internal_error`.
	 */
	it('refuses text this device has no keys for, before anything is sent', async () => {
		const thrown = await backend.typeText(BOOTED, 'café').catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(UnsupportedTextError);
		expect((thrown as UnsupportedTextError).serial).toBe(BOOTED);
		expect((thrown as UnsupportedTextError).unsupported.join(' ')).toContain('U+00E9');
		expect((thrown as UnsupportedTextError).message).toContain('printable ASCII');
		expect(companionStream).not.toHaveBeenCalled();
	});

	/** A device that is not booted is refused before a companion is started, `readScreen`'s reason. */
	it.each([
		['tap', () => backend.tap(IPHONE_17_PRO, { x: 1, y: 1 })],
		['swipe', () => backend.swipe(IPHONE_17_PRO, { x: 1, y: 1 }, { x: 2, y: 2 }, 100)],
		['typeText', () => backend.typeText(IPHONE_17_PRO, 'a')],
		['pressKey', () => backend.pressKey(IPHONE_17_PRO, 'home')],
	])('refuses %s on a device that is not booted, without reaching for a companion', async (_what, inject) => {
		await expect(inject()).rejects.toThrow(/'offline' rather than ready/);

		expect(companionStream).not.toHaveBeenCalled();
	});

	/** And a device the enumeration no longer names is the contract's own vanishing, not a state. */
	it('reports a device that has gone as vanished', async () => {
		await expect(backend.tap(GONE, { x: 1, y: 1 })).rejects.toThrow(DeviceVanishedError);

		expect(companionStream).not.toHaveBeenCalled();
	});

	it('presses home unconditionally, without reading any state first', async () => {
		await backend.pressKey(BOOTED, 'home');

		expect(companionStream).toHaveBeenCalledWith(BOOTED, 'hid', [
			{ press: { action: { button: { button: 'HOME' } }, direction: 'DOWN' } },
			{ press: { action: { button: { button: 'HOME' } }, direction: 'UP' } },
		]);
		expect(runSimctlOnDevice).not.toHaveBeenCalled();
	});

	/**
	 * **`wake` on a woken device sends nothing at all**, which is the whole of it being idempotent:
	 * the button behind it toggles, so an unconditional press would put the device to sleep.
	 */
	it('sends nothing when wake is asked of a device whose screen is already on', async () => {
		runSimctlOnDevice.mockResolvedValue({
			stdout: `${SCREEN_BLANKED_NOTIFICATION} 0\n`,
			stderr: '',
		});

		await backend.pressKey(BOOTED, 'wake');

		expect(runSimctlOnDevice).toHaveBeenCalledWith(BOOTED, 'spawn', [...READ_SCREEN_BLANKED_ARGV]);
		expect(companionStream).not.toHaveBeenCalled();
	});

	it('presses lock when wake is asked of a device whose screen is off', async () => {
		runSimctlOnDevice.mockResolvedValue({
			stdout: `${SCREEN_BLANKED_NOTIFICATION} 1\n`,
			stderr: '',
		});

		await backend.pressKey(BOOTED, 'wake');

		expect(companionStream).toHaveBeenCalledWith(BOOTED, 'hid', [
			{ press: { action: { button: { button: 'LOCK' } }, direction: 'DOWN' } },
			{ press: { action: { button: { button: 'LOCK' } }, direction: 'UP' } },
		]);
	});

	/** A read that cannot be believed must not be turned into "no press needed". */
	it('fails a wake whose state read answered something else', async () => {
		runSimctlOnDevice.mockResolvedValue({ stdout: 'com.apple.something.else 1\n', stderr: '' });

		await expect(backend.pressKey(BOOTED, 'wake')).rejects.toThrow(/not the one/);

		expect(companionStream).not.toHaveBeenCalled();
	});

	/**
	 * **The two refusals, by name, and before any round trip.** `back` and `recents` have no answer
	 * on this platform in any device state, so asking the enumeration first would spend a call to
	 * reach the same sentence — and `UnsupportedKeyError` rather than `MissingCapabilityError`,
	 * because this device does take input and the other three verbs work (#215).
	 */
	it.each([
		'back',
		'recents',
	] as const)('refuses the %s key by name, without asking the device anything', async (key) => {
		const thrown = await backend.pressKey(BOOTED, key).catch((error: unknown) => error);

		expect(thrown).toBeInstanceOf(UnsupportedKeyError);
		expect((thrown as UnsupportedKeyError).key).toBe(key);
		expect((thrown as UnsupportedKeyError).serial).toBe(BOOTED);
		expect(runSimctl).not.toHaveBeenCalled();
		expect(companionStream).not.toHaveBeenCalled();
	});

	/** A companion that died is an interruption and reaches the caller as itself, never a device fault. */
	it('lets a companion interruption through as itself', async () => {
		companionStream.mockRejectedValue(
			new IdbCompanionInterruptedError(unwrap(BOOTED), 'hid', 'died'),
		);

		await expect(backend.tap(BOOTED, { x: 1, y: 1 })).rejects.toBeInstanceOf(
			IdbCompanionInterruptedError,
		);
	});
});

/**
 * The log read against the **captured** NDJSON of `tests/fixtures/ios-simulator/`, which is what
 * makes the bound and the ordering assertable without a simulator. The parse itself is
 * `parsers/unified-log.test.ts`'s subject and is not re-asserted here; what this covers is the
 * argv, the cap and what `truncated` means.
 */
describe('readLogs', () => {
	/** One process, one minute, off the booted device of the fixtures' bench: 53 lines, 52 entries. */
	const CAPTURED_LOG = readFileSync(
		fixtureUrl('unified-log-ndjson.xcode26.4.1-ios26.4.1.json'),
		'utf8',
	);
	const CAPTURED_ENTRIES = 52;

	/** The trailer alone — what a window in which the device said nothing comes back as. */
	const NOTHING = '{"count":0,"finished":1}\n';

	/** The stderr an ordinary run writes while exiting 0 on this platform. */
	const NOISE = 'getpwuid_r did not find a match for uid 501\n';

	/** How many reads a cap the device never fills costs — every width, once (`LOG_WINDOWS`). */
	const LOG_WIDTHS = LOG_WINDOWS.length;

	/** The two suffixes `LOG_WINDOWS` spells its widths with, as seconds. */
	function secondsOf(window: string): number {
		const [, count, unit] = /^(\d+)([sm])$/.exec(window) ?? [];
		if (count === undefined) throw new Error(`a window this helper cannot read: ${window}`);
		return Number(count) * (unit === 'm' ? 60 : 1);
	}

	/** The `--last` argument of every read made so far, in the order they were made. */
	function windowsAsked(): (string | undefined)[] {
		return runSimctlOnDevice.mock.calls.map((call) => (call[2] as string[]).at(-1));
	}

	function reads(stdout: string): void {
		runSimctlOnDevice.mockResolvedValue({ stdout, stderr: NOISE });
	}

	beforeEach(() => {
		reads(CAPTURED_LOG);
	});

	/**
	 * The whole argv as a literal, because every entry of it is load-bearing: `spawn` is what runs
	 * the query inside the device rather than against this Mac's own log, `--style ndjson` is the
	 * shape the parser is pinned against, `--info --debug` are what keep two of the five levels
	 * from being silently missing, and `--last` is the pushdown.
	 *
	 * The narrowest width is what a read starts at, and a cap this capture fills is what keeps it
	 * there — the widening is the case below.
	 */
	it('asks the device’s own log for one bounded window, pinned to the device', async () => {
		await backend.readLogs(BOOTED, { maxEntries: 5 });

		expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
		expect(runSimctlOnDevice.mock.calls[0]?.slice(0, 3)).toEqual([
			BOOTED,
			'spawn',
			['log', 'show', '--style', 'ndjson', '--info', '--debug', '--last', '30s'],
		]);
	});

	// A window bounds a duration and not a size, and a minute of this output measured past the
	// runner's default buffer on an idle simulator (`simctl.ts`).
	it('gives the read room for an answer that is a payload rather than a listing', async () => {
		await backend.readLogs(BOOTED, { maxEntries: 200 });

		for (const call of runSimctlOnDevice.mock.calls) {
			expect(call[3]?.maxBufferBytes).toBe(READ_LOGS_SIMCTL_MAX_BUFFER_BYTES);
		}
	});

	/**
	 * The finding this method was rewritten for: a window that held less than the cap is not an
	 * answer the cap bound, so reporting it as `truncated: false` off the first read would tell a
	 * caller nothing older was dropped while the device's store held an order of magnitude more.
	 * The widths are tried in order until one of them says more than the cap.
	 */
	it('widens the window while the device said no more than the cap', async () => {
		await backend.readLogs(BOOTED, { maxEntries: 200 });

		expect(windowsAsked()).toEqual([...LOG_WINDOWS]);
	});

	/** A cap the first width fills is the common case, and it costs exactly the one read. */
	it('stops at the first width that said more than the cap', async () => {
		const read = await backend.readLogs(BOOTED, { maxEntries: 5 });

		expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
		expect(read.truncated).toBe(true);
	});

	it('answers the widest window’s entries when they fit under the cap', async () => {
		const read = await backend.readLogs(BOOTED, { maxEntries: 200 });

		expect(read.entries).toHaveLength(CAPTURED_ENTRIES);
		expect(read.truncated).toBe(false);
	});

	/** A log read is asked *after* something happened, so the newest are the ones kept. */
	it('keeps the newest entries when the device said more than the cap, and says so', async () => {
		const all = await backend.readLogs(BOOTED, { maxEntries: CAPTURED_ENTRIES });
		const read = await backend.readLogs(BOOTED, { maxEntries: 5 });

		expect(read.truncated).toBe(true);
		expect(read.entries).toEqual(all.entries.slice(-5));
	});

	/**
	 * The exact-fit case, which is what `truncated` is easy to get wrong on: the widest width held
	 * exactly the cap, so nothing was dropped *for the cap's sake*. `log show` has no count bound
	 * to ask one more than the cap of — the widening is what stands in for the Android side's
	 * `+ 1`, and it has to run out before this may be answered.
	 */
	it('answers exactly the cap without calling it truncated', async () => {
		const read = await backend.readLogs(BOOTED, { maxEntries: CAPTURED_ENTRIES });

		expect(runSimctlOnDevice).toHaveBeenCalledTimes(LOG_WIDTHS);
		expect(read.entries).toHaveLength(CAPTURED_ENTRIES);
		expect(read.truncated).toBe(false);
	});

	/**
	 * The number the finding turned on. A single 30 s window holds 2,000–4,800 entries at the
	 * 67–160 entries per second this bench measured, which is *under* `MAX_LOG_ENTRIES` — so the
	 * lookback rather than the cap decided the answer at the contract's own ceiling. Pinned
	 * against the slowest rate measured, so that shrinking the widest width, or raising the
	 * ceiling, cannot quietly put the lookback back in charge.
	 */
	it('carries a widest window that covers the contract’s ceiling at the slowest measured rate', () => {
		const SLOWEST_ENTRIES_PER_SECOND = 67;
		const widths = LOG_WINDOWS.map(secondsOf);

		expect(widths.at(-1) as number).toBeGreaterThan(MAX_LOG_ENTRIES / SLOWEST_ENTRIES_PER_SECOND);
		expect(widths).toEqual([...widths].sort((a, b) => a - b));
		expect(new Set(widths).size).toBe(widths.length);
	});

	/**
	 * The overflow as the runner builds one: `killed`, and a `code` that is Node's rather than an
	 * exit status. The buffered half comes back with it, and is deliberately *not* what this
	 * backend answers from — `log show` writes oldest-first, so a partial buffer is the oldest
	 * bytes of the window where a log read is asked for the newest.
	 */
	function overflowed(): SimctlCommandError {
		return new SimctlCommandError(
			['spawn', BOOTED, 'log', 'show', '--style', 'ndjson', '--info', '--debug', '--last', '2m'],
			10_000,
			Object.assign(new Error('stdout maxBuffer length exceeded'), {
				code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
				killed: true,
			}),
			CAPTURED_LOG,
			NOISE,
		);
	}

	/**
	 * The regression the escalation introduced, and the bound that answers it. A width bounds a
	 * duration and not a size, and a burst that has aged out of the narrowest width is still
	 * inside a wider one — measured at 113.6 MB / 191.8 MB / 232.4 MB across the three widths a
	 * minute past boot (`backend.ts`), against a 64 MB buffer. An overflow there is proof the
	 * device said far more than the cap, which is the one thing the widening was asking, so the
	 * narrower width's answer stands rather than the read failing.
	 */
	it('keeps the narrower window’s answer when a wider one outgrew the buffer', async () => {
		runSimctlOnDevice
			.mockResolvedValueOnce({ stdout: CAPTURED_LOG, stderr: NOISE })
			.mockRejectedValueOnce(overflowed());

		const read = await backend.readLogs(BOOTED, { maxEntries: 200 });

		expect(read.entries).toHaveLength(CAPTURED_ENTRIES);
		expect(read.truncated).toBe(true);
		expect(windowsAsked()).toEqual(LOG_WINDOWS.slice(0, 2));
	});

	/** The cap is still applied to what is kept: the fallback answers the newest, like any read. */
	it('slices the kept answer to the cap when the wider window overflowed', async () => {
		const all = (await backend.readLogs(BOOTED, { maxEntries: CAPTURED_ENTRIES })).entries;
		runSimctlOnDevice.mockReset();
		runSimctlOnDevice
			.mockResolvedValueOnce({ stdout: CAPTURED_LOG, stderr: NOISE })
			.mockRejectedValueOnce(overflowed());

		const read = await backend.readLogs(BOOTED, { maxEntries: 20 });

		expect(read.entries).toEqual(all.slice(-20));
		expect(read.truncated).toBe(true);
	});

	/**
	 * The narrowest width has nothing to fall back on, so the read fails loudly rather than
	 * answering from a buffer holding the wrong end of the window. Reachable on a real host for
	 * the first minutes after a boot, at any cap at all (`backend.ts`).
	 */
	it('fails the read when the narrowest window outgrew the buffer, and asks no wider one', async () => {
		runSimctlOnDevice.mockRejectedValue(overflowed());

		await expect(backend.readLogs(BOOTED, { maxEntries: 200 })).rejects.toThrow(
			'said more than its buffer holds',
		);
		expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
	});

	/** Only an overflow ends the widening quietly — an ordinary failure is still a failure. */
	it('lets a wider window’s ordinary failure through rather than answering the narrower one', async () => {
		runSimctlOnDevice
			.mockResolvedValueOnce({ stdout: CAPTURED_LOG, stderr: NOISE })
			.mockRejectedValueOnce(refusedWith(149, 'device is not booted'));

		await expect(backend.readLogs(BOOTED, { maxEntries: 200 })).rejects.toThrow('exited 149');
		expect(runSimctlOnDevice).toHaveBeenCalledTimes(2);
	});

	it('answers a device that said nothing as empty rather than as a failure', async () => {
		reads(NOTHING);

		expect(await backend.readLogs(BOOTED, { maxEntries: 200 })).toEqual({
			entries: [],
			truncated: false,
		});
		expect(runSimctlOnDevice).toHaveBeenCalledTimes(LOG_WIDTHS);
	});

	/**
	 * No state check here, unlike the capture, and this is the reason: the tool refuses a device
	 * that is not booted in 0.15 s at exit 149, so there is nothing to pre-empt and an enumeration
	 * would be bought for nothing (measured, `backend.ts`).
	 */
	it('lets the tool refuse a device that is not booted, without an enumeration of its own', async () => {
		runSimctlOnDevice.mockRejectedValue(
			refusedWith(149, 'Process spawn via launchd failed because device is not booted.'),
		);

		await expect(backend.readLogs(IPHONE_17_PRO, { maxEntries: 200 })).rejects.toThrow(
			'exited 149',
		);
		expect(runSimctl).not.toHaveBeenCalled();
		expect(runSimctlOnDevice).toHaveBeenCalledTimes(1);
	});
});

/**
 * Every required method, held to the sentinel the conformance gate scans for
 * (`tests/helpers/backend-conformance.ts`) — and **there is none left to find**.
 *
 * Driven off `REQUIRED_BACKEND_METHODS` rather than off a list written here, so a method added to
 * `DeviceBackend` joins this suite with no edit and arrives unanswered rather than unnoticed. The
 * count is asserted for the reason the stub count used to be: a phase that answers one has to
 * change this deliberately rather than have the case pass on a shorter list.
 */
describe('the required methods', () => {
	/** The source of each one, which is what the gate's own scans read. */
	const sourceOf = (name: (typeof REQUIRED_BACKEND_METHODS)[number]): string =>
		String(backend[name]);

	it('is the twelve of the contract, every one of them answered here', () => {
		expect(REQUIRED_BACKEND_METHODS).toHaveLength(12);
		expect(REQUIRED_BACKEND_METHODS.filter((name) => STUB_SENTINEL.test(sourceOf(name)))).toEqual(
			[],
		);
	});

	it.each(REQUIRED_BACKEND_METHODS)('%s is real rather than a stub', (name) => {
		expect(sourceOf(name)).not.toMatch(STUB_SENTINEL);
	});
});

/**
 * The recorder, with the process replaced and the *file* real — which is deliberate rather than
 * convenient. Whether the bytes handed over are a finished container is decided on what was
 * actually on disk (`recordVideo`), so a suite that stubbed `readFile` would be asserting its own
 * arrangement; instead the fake recorder writes the committed capture where the backend derived
 * its path, exactly as `simctl` would.
 *
 * What no mock can say is here in `tests/device/ios-simulator/recording.test.ts`: that a simulator
 * answers this argv at all, that the marker arrives, and that `SIGINT` produces a file a player
 * will open.
 */
const RECORDING_FIXTURE = new Uint8Array(
	readFileSync(fixtureUrl('recordvideo.finished.xcode26.6-ios26.5.mov')),
);

/** Where the backend derives a recording's path — restated here rather than imported, so a
 * change to the derivation shows up as a failure instead of following the test along. */
const recordingPathOf = (serial: DeviceSerial): string =>
	join(tmpdir(), `rover-ios-recording-${String(serial)}.mov`);

/** What a masked argv entry reads as, restated here for {@link recordingPathOf}'s reason. */
const REDACTED_ARGV = '<the file you sent>';

/** A process table naming one recorder for `serial`, in the shape `ps` prints one. */
const tableRecording = (serial: DeviceSerial, pid = '31473'): string =>
	`${pid} /Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl io ${String(serial)} recordVideo --codec h264 --mask ignored ${recordingPathOf(serial)}\n`;

/** What a fake recorder was asked to do, and the handles the case drives it by. */
interface FakeRecorder {
	readonly signals: NodeJS.Signals[];
	readonly released: () => boolean;
	/** End the run, as `close` would. */
	readonly end: () => void;
}

/**
 * Install a fake recorder.
 *
 * `announce` decides what the run says before anything awaits it: `'started'` writes both the
 * note and the marker to stderr synchronously, so the start wait is met on its first probe and
 * no case pays a poll interval for the ordinary path. `'refused'` writes the exit-16 refusal and
 * ends, which is what a second recorder or a stuck device lock does. `'silent'` says nothing at
 * all, which is what times out.
 *
 * `onSignal` is what the recording is stopped by: the fake ends the run when it is signalled,
 * which is what the real one does 20–30 ms after `SIGINT`. A case that wants a recorder that
 * ignores the signal passes `'ignore'`.
 */
function recorderThat(
	announce: 'started' | 'refused' | 'silent',
	options: { onSignal?: 'end' | 'ignore'; writes?: Uint8Array | null } = {},
): FakeRecorder {
	const signals: NodeJS.Signals[] = [];
	let released = false;
	let end = (): void => {};

	streamSimctlOnDevice.mockImplementation((serial, subcommand, args, handlers, runner) => {
		// The end reason as the real runner builds it: the whole argv, with whatever `redactArgv`
		// named masked as whole entries (`src/backends/ios-simulator/simctl.ts`). Spelled out here
		// because the leak this pins is *in* that argv — a fake that elided it could not see it.
		const quoted = [subcommand, String(serial), ...args]
			.map((entry) => (runner?.redactArgv?.includes(entry) === true ? REDACTED_ARGV : entry))
			.join(' ');
		let ended = false;
		end = (): void => {
			if (ended) return;
			ended = true;
			handlers.onEnd(`simctl ${quoted} ended with exit 0`);
		};

		if (announce === 'started') {
			handlers.onStderr('Note: No display specified. Defaulting to display: … (name: LCD)\n');
			handlers.onStderr('Recording started\n');
		}
		if (announce === 'refused') {
			handlers.onStderr(
				'Error starting video recorder: Error Domain=NSPOSIXErrorDomain Code=16 ' +
					'"Resource busy" UserInfo={NSLocalizedFailureReason=Host recording is already in ' +
					'progress}.\n',
			);
			handlers.onStdout(`the path was ${args[args.length - 1]}\n`);
			handlers.onEnd(`simctl ${quoted} ended with exit 16`);
			ended = true;
		}

		return {
			pid: 31473,
			release: () => {
				released = true;
			},
			signal: (signal: NodeJS.Signals) => {
				signals.push(signal);
				if (options.onSignal === 'ignore') return;
				// What the real recorder does as it goes: the whole container, then the exit.
				const bytes = options.writes === undefined ? RECORDING_FIXTURE : options.writes;
				if (bytes !== null) writeFileSync(recordingPathOf(serial), bytes);
				end();
			},
		};
	});

	return { end: () => end(), released: () => released, signals };
}

/** The listing, with one device's state changed — how a case says "not booted". */
const withState = (serial: DeviceSerial, state: string): string =>
	listing((parsed) => {
		entryOf(parsed, String(serial)).state = state;
	});

afterEach(async () => {
	await rm(recordingPathOf(BOOTED), { force: true });
});

describe('recordVideo', () => {
	/**
	 * The order the whole method is: the device is checked, the machine is asked whether it is
	 * recording, the file is removed, and only then is anything spawned. Asserted as an order and
	 * not just as a set of calls, because each step exists to stop the next one being reached in a
	 * state it cannot answer from.
	 */
	it('checks the device and asks the machine before it spawns anything', async () => {
		answers(listing());
		recorderThat('started');

		await backend.recordVideo(BOOTED, { durationMs: 0 });

		expect(runSimctl.mock.calls[0]?.[0]).toEqual(ENUMERATE);
		expect(readProcessTable).toHaveBeenCalled();
		expect(streamSimctlOnDevice).toHaveBeenCalledTimes(1);
	});

	// Every flag load-bearing: the codec because the default is `hevc`, the mask because the
	// default hands back the device's rounded corners, and the path because there is no stdout.
	it('records to a path derived from the udid, with the codec and the mask asked for', async () => {
		answers(listing());
		recorderThat('started');

		await backend.recordVideo(BOOTED, { durationMs: 0 });

		expect(streamSimctlOnDevice.mock.calls[0]?.[0]).toBe(BOOTED);
		expect(streamSimctlOnDevice.mock.calls[0]?.[1]).toBe('io');
		expect(streamSimctlOnDevice.mock.calls[0]?.[2]).toEqual([
			'recordVideo',
			'--codec',
			'h264',
			'--mask',
			'ignored',
			recordingPathOf(BOOTED),
		]);
	});

	it('answers with the bytes the recorder wrote', async () => {
		answers(listing());
		recorderThat('started');

		expect(Uint8Array.from(await backend.recordVideo(BOOTED, { durationMs: 0 }))).toEqual(
			RECORDING_FIXTURE,
		);
	});

	/**
	 * `simctl io recordVideo` has no `--time-limit`, so the window is a deadline timer here whose
	 * callback sends the signal — which is what actually ends the recording. If it did not fire,
	 * nothing would.
	 */
	it('ends the recording by signalling it, never by waiting the duration out', async () => {
		answers(listing());
		const recorder = recorderThat('started');

		await backend.recordVideo(BOOTED, { durationMs: 0 });

		expect(recorder.signals[0]).toBe('SIGINT');
	});

	/**
	 * The refusal the process table decides, ahead of the tool's own: `simctl` would answer exit
	 * 16 for a second recorder, and what a caller needs to hear is *this device is already
	 * recording, stop that one first* — with the pids, because a recorder this host started and
	 * one some other program started are the same refusal and different remedies.
	 */
	it('refuses a device the machine says is already recording, naming the pids', async () => {
		answers(listing());
		readProcessTable.mockResolvedValue(tableRecording(BOOTED, '9182'));
		recorderThat('started');

		const rejection = backend.recordVideo(BOOTED, { durationMs: 0 });

		await expect(rejection).rejects.toBeInstanceOf(RecordingAlreadyRunningError);
		await expect(rejection).rejects.toThrow(/9182/);
		expect(streamSimctlOnDevice).not.toHaveBeenCalled();
	});

	/**
	 * The sharpest case of the phase. A recording on a device that is not booted prints
	 * `Recording started`, runs for as long as it is left, exits 0 with `Recording completed.` and
	 * writes zero bytes — so the marker cannot catch it and only the state check can.
	 */
	it('refuses a device that is not booted before a recorder is started', async () => {
		answers(withState(BOOTED, 'Shutdown'));
		recorderThat('started');

		const rejection = backend.recordVideo(BOOTED, { durationMs: 0 });

		await expect(rejection).rejects.toThrow(/rather than ready/);
		await expect(rejection).rejects.toThrow(/zero bytes/);
		expect(streamSimctlOnDevice).not.toHaveBeenCalled();
	});

	// The contract's own distinction from `describeDevice`'s `null`.
	it('throws for a device this host does not have at all', async () => {
		answers(withoutDevice(BOOTED));
		recorderThat('started');

		await expect(backend.recordVideo(BOOTED, { durationMs: 0 })).rejects.toBeInstanceOf(
			DeviceVanishedError,
		);
	});

	/**
	 * A leftover from a run that died before its cleanup can never be the file that is read —
	 * and because there is no `--force`, the removal is also what keeps the tool from refusing at
	 * exit 17 on a path that already exists.
	 */
	it('removes a leftover recording before starting, and again afterwards', async () => {
		answers(listing());
		await writeFile(recordingPathOf(BOOTED), 'a recording a killed run left behind');
		recorderThat('started');

		await backend.recordVideo(BOOTED, { durationMs: 0 });

		await expect(stat(recordingPathOf(BOOTED))).rejects.toThrow();
	});

	/**
	 * The bytes decide, not the exit code: a recorder that produced nothing exits 0 and says it
	 * finished. `UnfinishedRecordingError` names the length so the two shapes of that failure are
	 * distinguishable — a few kilobytes is a recording caught at its beginning, zero is one that
	 * never had a frame.
	 */
	it('refuses a recording with no index box, naming the byte length', async () => {
		answers(listing());
		recorderThat('started', { writes: new Uint8Array() });

		const rejection = backend.recordVideo(BOOTED, { durationMs: 0 });

		await expect(rejection).rejects.toBeInstanceOf(UnfinishedRecordingError);
		await expect(rejection).rejects.toThrow(/is 0 bytes with no index block/);
	});

	// simctl reported having written the file and there is none: this host's answer, not the
	// device's, and never the "nothing was recording" one.
	it('says so when the file the recorder was told to write is not there', async () => {
		answers(listing());
		recorderThat('started', { writes: null });

		await expect(backend.recordVideo(BOOTED, { durationMs: 0 })).rejects.toThrow(
			/could not be read back/,
		);
	});

	/**
	 * The one failure the marker turns from a ten-second wait into the tool's own sentence, and
	 * both streams are quoted because on this tool the useful half is as often on stdout.
	 */
	it('reports a recorder that ended before it said it had started, with both streams', async () => {
		answers(listing());
		recorderThat('refused');

		const rejection = backend.recordVideo(BOOTED, { durationMs: 0 });

		await expect(rejection).rejects.toThrow(/before it reported having started/);
		await expect(rejection).rejects.toThrow(/Host recording is already in progress/);
		await expect(rejection).rejects.toThrow(/stdout: the path was/);
	});

	/**
	 * The staged path is this host's, and the message is read on the agent's machine (D19).
	 *
	 * Asserted as an **absence**, because the token appearing somewhere is not the claim: the path
	 * is in the recorder's argv as well as in its streams, and the argv is half of the `reason`
	 * this failure quotes. A case that only looked for the token passed while the path came
	 * through beside it.
	 */
	it('keeps the path it derived out of the failure it reports', async () => {
		answers(listing());
		recorderThat('refused');

		const rejection = backend.recordVideo(BOOTED, { durationMs: 0 });

		await expect(rejection).rejects.toThrow(/<the file you sent>/);
		await expect(rejection).rejects.not.toThrow(new RegExp(recordingPathOf(BOOTED)));
	});

	/**
	 * Nothing above this backend keeps two calls off one file — `src/daemon/verb-traffic.ts`
	 * registers concurrent calls on one device rather than preventing them — and the path is
	 * derived from the udid, so two overlapping recordings would share it and spoil both.
	 */
	it('runs two recordings on one device one after the other rather than beside each other', async () => {
		answers(listing());
		let spawned = 0;
		let overlapping = 0;
		streamSimctlOnDevice.mockImplementation((serial, _subcommand, _args, handlers) => {
			spawned += 1;
			overlapping = Math.max(overlapping, spawned);
			handlers.onStderr('Recording started\n');
			return {
				pid: 1,
				release: () => {},
				signal: () => {
					spawned -= 1;
					writeFileSync(recordingPathOf(serial), RECORDING_FIXTURE);
					handlers.onEnd('ended with exit 0');
				},
			};
		});

		await Promise.all([
			backend.recordVideo(BOOTED, { durationMs: 0 }),
			backend.recordVideo(BOOTED, { durationMs: 0 }),
		]);

		expect(overlapping).toBe(1);
	});
});

describe('startRecording', () => {
	/**
	 * The whole point of the method: it answers while the recorder runs, and the handle is
	 * released so the run outlives the call — nothing is destroyed, because the recorder still
	 * has to write the file.
	 */
	it('answers once the recorder has said it started, and lets the run outlive the call', async () => {
		answers(listing());
		const recorder = recorderThat('started');

		await backend.startRecording(BOOTED, { maxDurationMs: 15_000 });

		expect(recorder.released()).toBe(true);
		expect(recorder.signals).toEqual([]);
	});

	// The same argv as the fixed window, because it is the same recording — what differs is only
	// what stops it.
	it('records with the same flags and to the same derived path', async () => {
		answers(listing());
		recorderThat('started');

		await backend.startRecording(BOOTED, { maxDurationMs: 15_000 });

		expect(streamSimctlOnDevice.mock.calls[0]?.[2]).toEqual([
			'recordVideo',
			'--codec',
			'h264',
			'--mask',
			'ignored',
			recordingPathOf(BOOTED),
		]);
	});

	/**
	 * `maxDurationMs` is the recorder's own kill switch, and on this platform it is a timer in
	 * *this* process — there is no `--time-limit` to hand the device. A non-positive one stops the
	 * recorder rather than removing the limit, which is the safe direction and the opposite of the
	 * trap `RecordVideoOptions.durationMs` records.
	 */
	it('arms the limit as a signal rather than passing it to the tool', async () => {
		answers(listing());
		const recorder = recorderThat('started', { onSignal: 'ignore' });

		await backend.startRecording(BOOTED, { maxDurationMs: 0 });
		await drainEventLoop();

		expect(streamSimctlOnDevice.mock.calls[0]?.[2]).not.toContain('--time-limit');
		expect(recorder.signals).toEqual(['SIGINT']);
	});

	it('refuses a device that is already recording, and starts nothing', async () => {
		answers(listing());
		readProcessTable.mockResolvedValue(tableRecording(BOOTED));
		recorderThat('started');

		await expect(backend.startRecording(BOOTED, { maxDurationMs: 15_000 })).rejects.toBeInstanceOf(
			RecordingAlreadyRunningError,
		);
		expect(streamSimctlOnDevice).not.toHaveBeenCalled();
	});

	it('refuses a device that is not booted', async () => {
		answers(withState(BOOTED, 'Shutdown'));
		recorderThat('started');

		await expect(backend.startRecording(BOOTED, { maxDurationMs: 15_000 })).rejects.toThrow(
			/rather than ready/,
		);
	});

	it('reports a recorder that would not start rather than answering ok', async () => {
		answers(listing());
		recorderThat('refused');

		await expect(backend.startRecording(BOOTED, { maxDurationMs: 15_000 })).rejects.toThrow(
			/before it reported having started/,
		);
	});
});

describe('stopRecording', () => {
	/**
	 * The order: ask the machine, signal by pid, wait until the machine says it is gone, read,
	 * check, answer. Signalled **by pid** rather than through a handle, which is what lets this
	 * stop a recorder an earlier daemon started.
	 */
	it('signals the recorder the machine named and answers with the bytes', async () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		try {
			readProcessTable.mockResolvedValueOnce(tableRecording(BOOTED, '31473'));
			readProcessTable.mockResolvedValue('');
			await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE);

			expect(Uint8Array.from(await backend.stopRecording(BOOTED))).toEqual(RECORDING_FIXTURE);
			expect(kill).toHaveBeenCalledWith(31473, 'SIGINT');
		} finally {
			kill.mockRestore();
		}
	});

	/**
	 * A recorder that already stopped itself — it reached the limit `startRecording` armed — is
	 * not a failure: the file it left is complete, and this answers with it. So the branch is on
	 * whether there is anything to signal, not on whether anything went wrong.
	 */
	it('answers with the recording a recorder that stopped itself left behind', async () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		try {
			await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE);

			expect(Uint8Array.from(await backend.stopRecording(BOOTED))).toEqual(RECORDING_FIXTURE);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	// Nothing recording and nothing written: nothing happened, so a caller that stopped something
	// it never started is told so rather than handed an empty answer.
	it('refuses a stop for a recording that was never started', async () => {
		await expect(backend.stopRecording(BOOTED)).rejects.toBeInstanceOf(NoRecordingRunningError);
	});

	/**
	 * The other half of that pair, and the reason both facts are read: a recorder that ran against
	 * a device which had gone leaves nothing, which is a recording that did not finish rather than
	 * a stop nobody started.
	 */
	it('refuses a recorder that was running and left nothing behind', async () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		try {
			readProcessTable.mockResolvedValueOnce(tableRecording(BOOTED));
			readProcessTable.mockResolvedValue('');

			const rejection = backend.stopRecording(BOOTED);

			await expect(rejection).rejects.toBeInstanceOf(UnfinishedRecordingError);
			await expect(rejection).rejects.toThrow(/is 0 bytes/);
		} finally {
			kill.mockRestore();
		}
	});

	it('refuses bytes with no index box, naming what arrived', async () => {
		await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE.subarray(0, 20));

		const rejection = backend.stopRecording(BOOTED);

		await expect(rejection).rejects.toBeInstanceOf(UnfinishedRecordingError);
		await expect(rejection).rejects.toThrow(/is 20 bytes/);
	});

	/**
	 * The wait is on the machine's answer, not on the signal having been sent: a recorder that
	 * would not go is a `wait-timeout` naming the pids rather than a recording read out from under
	 * an encoder still writing it.
	 */
	it('waits until the machine says the recorder is gone', async () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		try {
			readProcessTable
				.mockResolvedValueOnce(tableRecording(BOOTED))
				.mockResolvedValueOnce(tableRecording(BOOTED))
				.mockResolvedValue('');
			await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE);

			expect(Uint8Array.from(await backend.stopRecording(BOOTED))).toEqual(RECORDING_FIXTURE);
			expect(readProcessTable.mock.calls.length).toBeGreaterThanOrEqual(3);
		} finally {
			kill.mockRestore();
		}
	});

	/**
	 * `ESRCH` between the read and the signal is not a broken device — the recorder reached its
	 * limit in the gap — and the wait that follows is what catches one that really would not go.
	 */
	it('tolerates a recorder that went away between the read and the signal', async () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
			throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
		});
		try {
			readProcessTable.mockResolvedValueOnce(tableRecording(BOOTED));
			readProcessTable.mockResolvedValue('');
			await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE);

			expect(Uint8Array.from(await backend.stopRecording(BOOTED))).toEqual(RECORDING_FIXTURE);
		} finally {
			kill.mockRestore();
		}
	});

	// The cleanup runs on the refusal paths too, where a multi-megabyte file left on borrowed
	// hardware does the most harm — and its own failure never replaces the answer.
	it('removes the recording after handing it over', async () => {
		await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE);

		await backend.stopRecording(BOOTED);

		await expect(stat(recordingPathOf(BOOTED))).rejects.toThrow();
	});

	it('removes the recording it refused as well', async () => {
		await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE.subarray(0, 20));

		await expect(backend.stopRecording(BOOTED)).rejects.toBeInstanceOf(UnfinishedRecordingError);
		await expect(stat(recordingPathOf(BOOTED))).rejects.toThrow();
	});

	/**
	 * The one thing a stop must not do is ask the device whether it is booted. A lease that ended
	 * on a device that went down still has a recording to collect, and the state check belongs
	 * where a recording is *started*.
	 */
	it('asks the device nothing about its state', async () => {
		await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE);

		await backend.stopRecording(BOOTED);

		expect(runSimctl).not.toHaveBeenCalled();
	});
});

describe('discardRecording', () => {
	/**
	 * It runs for every lease that ends and most leases never record anything (D9), so an idle
	 * device is a silent success — no signal, no read, no refusal.
	 */
	it('is a silent success on a device that is not recording', async () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		try {
			await expect(backend.discardRecording(BOOTED)).resolves.toBeUndefined();
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	it('stops the recorder the lease left running and removes the file', async () => {
		const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
		try {
			readProcessTable.mockResolvedValueOnce(tableRecording(BOOTED, '31473'));
			readProcessTable.mockResolvedValue('');
			await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE);

			await backend.discardRecording(BOOTED);

			expect(kill).toHaveBeenCalledWith(31473, 'SIGINT');
			await expect(stat(recordingPathOf(BOOTED))).rejects.toThrow();
		} finally {
			kill.mockRestore();
		}
	});

	/**
	 * It pulls nothing and checks nothing: a lease that ended has no caller to hand a recording
	 * to, and refusing an unfinished file — which is what an abandoned recorder usually leaves —
	 * would turn the ordinary case into a failure the teardown has to swallow.
	 */
	it('answers with nothing and refuses nothing, whatever the file holds', async () => {
		await writeFile(recordingPathOf(BOOTED), RECORDING_FIXTURE.subarray(0, 20));

		await expect(backend.discardRecording(BOOTED)).resolves.toBeUndefined();
		await expect(stat(recordingPathOf(BOOTED))).rejects.toThrow();
	});

	// It never asks whether the device is booted: a lease ends on devices that have gone down,
	// and there is still a file on this host to collect.
	it('asks the device nothing about its state', async () => {
		await backend.discardRecording(BOOTED);

		expect(runSimctl).not.toHaveBeenCalled();
	});

	/**
	 * The one place this departs from the stop deliberately: it has no answer to protect, and a
	 * recording still sitting on hardware that goes to somebody else next is precisely what it
	 * exists to prevent — so the removal's failure is not swallowed.
	 */
	it('reports a file it could not remove rather than passing for a teardown that ran', async () => {
		await mkdir(recordingPathOf(BOOTED), { recursive: true });
		await writeFile(join(recordingPathOf(BOOTED), 'in-the-way'), 'x');

		try {
			await expect(backend.discardRecording(BOOTED)).rejects.toThrow();
		} finally {
			await rm(recordingPathOf(BOOTED), { force: true, recursive: true });
		}
	});
});

describe('the capabilities this backend does not declare', () => {
	/**
	 * Read through the contract rather than off the class, because the class type is the *first*
	 * half of the proof: `backend.setWifiEnabled` does not typecheck at all, which is a stronger
	 * statement than `undefined` and the reason these assertions cannot be written directly. What
	 * they are about is what the layer that dispatches a verb sees — a `DeviceBackend` whose
	 * optional member is absent, so `MissingCapabilityError` is what fires
	 * (`requireCapability`, `src/core/capabilities.ts`).
	 */
	const contract = (): DeviceBackend => backend;

	/**
	 * An absent method beside a `false` flag is a complete backend; a stub beside it is one under
	 * construction (`ai/TESTING.md`). This is the executable half of `./capabilities.ts`'s
	 * argument that `canControlNetwork` is `false` **for good**: a simulator uses the host's
	 * network stack, and the only truthful `setWifiEnabled` would change the networking of a
	 * machine lending devices to other people. `simctl status_bar override --wifiMode failed`
	 * exists and is cosmetic, which is exactly the plausible-looking result ai/RULES.md §2
	 * forbids — so what a caller gets is `MissingCapabilityError`, from the verb layer, naming
	 * the capability.
	 */
	it('ships no network methods at all rather than ones that draw an icon', () => {
		expect(contract().setAirplaneMode).toBeUndefined();
		expect(contract().setWifiEnabled).toBeUndefined();
	});

	/**
	 * And the read and the four injections *are* here now, which is the assertion that keeps this
	 * pair honest: all five used to be absent beside `setAirplaneMode` and `setWifiEnabled`, so a
	 * change that flipped a flag and forgot a method would otherwise have left this file agreeing
	 * with the old shape. **`canInput` cannot move by halves** —
	 * `CAPABILITY_METHODS.canInput` names all four, so a manifest declaring it with three of them
	 * implemented fails the conformance gate.
	 */
	it('ships every method the manifest declares a capability for', () => {
		expect(contract().readScreen).toBeTypeOf('function');
		expect(contract().tap).toBeTypeOf('function');
		expect(contract().swipe).toBeTypeOf('function');
		expect(contract().typeText).toBeTypeOf('function');
		expect(contract().pressKey).toBeTypeOf('function');
	});
});

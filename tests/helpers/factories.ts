/**
 * Test data factories — sensible defaults + `Partial<T>` overrides, mirroring Swarm's
 * `tests/helpers/factories.ts` (ai/TESTING.md "Test data"). Prefer these over
 * hand-constructing the same fixture inline in every test.
 *
 * Objects with a schema are returned *parsed*, so a test holds the same branded shape
 * production code does; tests exercising invalid input build raw objects directly.
 *
 * The ids here are invented (`test-platform`) rather than borrowed from any real
 * backend — a fixture that names one would put a platform name in shared test code and
 * quietly bless the branching this layer exists to prevent.
 */

import { vi } from 'vitest';
import type { DeviceBackendRegistration } from '@/backends/manifest.js';
import {
	type Capabilities,
	type CapabilityManifest,
	CapabilityManifestSchema,
} from '@/core/capabilities.js';
import {
	type Device,
	type DeviceBackend,
	type DeviceInfo,
	DeviceInfoSchema,
	DeviceSchema,
	type DeviceWatch,
	type DeviceWatcher,
	type LogEntry,
	LogEntrySchema,
	type LogRead,
	LogReadSchema,
	type ScreenElement,
	ScreenElementSchema,
} from '@/core/device.js';
import { parseDeviceSerial, parseLeaseId } from '@/core/ids.js';
import { LEASE_TTL_MS, type Lease } from '@/daemon/leases.js';
import type { ProjectServices } from '@/daemon/project-services.js';
import { PORTS_PER_SLOT, SLOT_PORT_BASE, type Slot } from '@/daemon/slots.js';
import type { VerbContext } from '@/verbs/context.js';

export function createMockCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
	return {
		canReadScreen: true,
		canInput: true,
		canControlNetwork: true,
		canRecordVideo: true,
		...overrides,
	};
}

/**
 * Bytes shaped like the smallest thing a recorder could hand back: an `ftyp` box, then a
 * `moov` — the index a finished recording has and an unfinished one does not.
 *
 * Real box headers rather than three arbitrary bytes, because two things downstream read
 * them: `mediaTypeOf` sniffs the `ftyp` at offset 4 to answer `video/mp4`, and the Android
 * backend's `isFinishedRecording` looks for the `moov`. A fixture that carried neither would
 * make every test over it agree with a verb that had stopped checking.
 */
export function createMockRecordingBytes(): Uint8Array {
	const box = (type: string) => [
		0,
		0,
		0,
		8,
		...[...type].map((character) => character.charCodeAt(0)),
	];
	return Uint8Array.from([...box('ftyp'), ...box('moov')]);
}

/** The eight bytes every PNG starts with (PNG 1.2 §3.1) — the ones a frame is split on. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** CRC-32 over a chunk's type and data, as PNG 1.2 §3.2 defines it. */
function pngCrc(bytes: number[]): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

/** One `length:uint32`, type, data and CRC — the shape every PNG chunk has. */
function pngChunk(type: string, data: number[]): number[] {
	const typed = [...[...type].map((character) => character.charCodeAt(0)), ...data];
	const crc = pngCrc(typed);
	return [
		(data.length >>> 24) & 0xff,
		(data.length >>> 16) & 0xff,
		(data.length >>> 8) & 0xff,
		data.length & 0xff,
		...typed,
		(crc >>> 24) & 0xff,
		(crc >>> 16) & 0xff,
		(crc >>> 8) & 0xff,
		crc & 0xff,
	];
}

/**
 * A structurally real PNG: the signature, an `IHDR` carrying the size, one `IDAT` and an
 * `IEND`, with correct chunk lengths and correct CRCs.
 *
 * Real chunks rather than "a signature and some bytes", because the thing being tested reads
 * exactly this structure: the frame extractor walks chunk lengths to find where one image ends
 * and the next begins, so a fixture that only carried the signature would agree with a split
 * that searched for the signature — which is the split that gets a real frame stream wrong.
 *
 * `payload` is the `IDAT` data, and a test that wants the hard case passes bytes **containing
 * the signature**: a compressed image really does produce those eight bytes now and then, and
 * that is the payload a naive split cuts in half.
 */
export function createMockPngBytes(
	options: { width?: number; height?: number; payload?: readonly number[] } = {},
): Uint8Array {
	const width = options.width ?? 320;
	const height = options.height ?? 800;
	const uint32 = (value: number) => [
		(value >>> 24) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 8) & 0xff,
		value & 0xff,
	];
	// 8-bit truecolour, deflate, adaptive filtering, no interlace — the header a frame has.
	const header = [...uint32(width), ...uint32(height), 8, 2, 0, 0, 0];

	return Uint8Array.from([
		...PNG_SIGNATURE,
		...pngChunk('IHDR', header),
		...pngChunk('IDAT', [...(options.payload ?? [0x78, 0x9c, 0x01, 0x00])]),
		...pngChunk('IEND', []),
	]);
}

/** The bytes `image2pipe` writes for several frames: the images, concatenated, nothing else. */
export function createMockPngStream(images: readonly Uint8Array[]): Uint8Array {
	return Uint8Array.from(images.flatMap((image) => [...image]));
}

/**
 * One device as the host sees it. `osVersion` and `osApiLevel` carry
 * {@link createMockDeviceInfo}'s neutral values, so a test that compares a listed device
 * with the same device's `device_info` finds the two agreeing rather than differing for
 * no reason. Pass `null` for either to build the device that could not be asked.
 */
export function createMockDevice(overrides: Partial<Device> = {}): Device {
	return DeviceSchema.parse({
		serial: 'test-serial-1',
		platform: 'test-platform',
		model: 'Test Model',
		osVersion: '1.0',
		osApiLevel: 1,
		state: 'ready',
		attachment: 'this-host',
		...overrides,
	});
}

/**
 * A lease record as the store holds it — an id, a serial and the three caller-supplied
 * attribution strings (D16, D22).
 *
 * `createdAtMs` is now, and `expiresAtMs` a full TTL out, because that is what the record
 * carries; what crosses the wire is the remaining duration (D17). Note that this builds a
 * record, it does not put one in a store — a test that needs a *held* device acquires it.
 *
 * The slot is slot 0's real block (R18), derived from the exported constants rather than
 * written out, so a record built here says what a granted one would.
 */
export function createMockLease(overrides: Partial<Lease> = {}): Lease {
	return {
		id: parseLeaseId('test-lease-1'),
		serial: parseDeviceSerial('test-serial-1'),
		owner: 'issue-112',
		project: 'test-project',
		testName: 'test-name-1',
		createdAtMs: Date.now(),
		expiresAtMs: Date.now() + LEASE_TTL_MS,
		slot: createMockSlot(),
		...overrides,
	};
}

/** Slot 0's real block, for a test that needs one without standing a pool up. */
export function createMockSlot(overrides: Partial<Slot> = {}): Slot {
	return { index: 0, portBase: SLOT_PORT_BASE, portCount: PORTS_PER_SLOT, ...overrides };
}

/**
 * The `device_info` answer for a device with a 3× density — the scale a dp value is
 * only ever derived from (D14). `widthDp`/`heightDp` are the exact quotients the
 * contract asks for, not rounded ones.
 */
export function createMockDeviceInfo(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
	return DeviceInfoSchema.parse({
		serial: 'test-serial-1',
		platform: 'test-platform',
		model: 'Test Model',
		screen: {
			widthPx: 1080,
			heightPx: 2400,
			density: 480,
			densityScale: 3,
			widthDp: 360,
			heightDp: 800,
		},
		osVersion: '1.0',
		osApiLevel: 1,
		...overrides,
	});
}

/**
 * One element of a screen read. `text` and `label` stay separate — an element carrying one
 * and not the other is the case a target resolver has to get right, so a factory that
 * filled both by default would hide it.
 *
 * `id` is taken as a plain string and branded on the way through, because a screen fixture
 * names several elements at once and `parseElementId` around each of them would be all a
 * reader saw.
 */
export function createMockScreenElement(
	overrides: Partial<Omit<ScreenElement, 'id'>> & { readonly id?: string } = {},
): ScreenElement {
	return ScreenElementSchema.parse({
		id: 'test-element-1',
		text: 'Save',
		label: null,
		bounds: { x: 10, y: 20, width: 100, height: 40 },
		...overrides,
	});
}

/**
 * One line of a device log. The timestamp is the device's own **string** — there is no
 * epoch here to convert, because the host shares no clock with the device (D17).
 */
export function createMockLogEntry(overrides: Partial<LogEntry> = {}): LogEntry {
	return LogEntrySchema.parse({
		timestamp: '01-02 03:04:05.678',
		level: 'info',
		tag: 'TestTag',
		pid: 1234,
		message: 'a line the device printed',
		...overrides,
	});
}

/**
 * One bounded log read. `truncated: false` by default — a test about the *bound* says so
 * explicitly, because that flag is the difference between a short read and a quiet device.
 */
export function createMockLogRead(overrides: Partial<LogRead> = {}): LogRead {
	return LogReadSchema.parse({
		entries: [createMockLogEntry()],
		truncated: false,
		...overrides,
	});
}

export function createMockCapabilityManifest(
	overrides: Partial<CapabilityManifest> = {},
): CapabilityManifest {
	return CapabilityManifestSchema.parse({
		platform: 'test-platform',
		label: 'Test',
		capabilities: createMockCapabilities(),
		...overrides,
	});
}

/**
 * A backend answering every method, including the capability-gated ones. Mocks carry
 * their real call signature so `mock.calls[0][0]` typechecks (ai/TESTING.md).
 */
export function createMockDeviceBackend(overrides: Partial<DeviceBackend> = {}): DeviceBackend {
	return {
		listDevices: vi.fn<DeviceBackend['listDevices']>(async () => [createMockDevice()]),
		watchDevices: vi.fn<DeviceBackend['watchDevices']>((watcher) => {
			watcher.onDevices([createMockDevice()]);
			return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
		}),
		describeDevice: vi.fn<DeviceBackend['describeDevice']>(async () => createMockDevice()),
		deviceInfo: vi.fn<DeviceBackend['deviceInfo']>(async () => createMockDeviceInfo()),
		installApp: vi.fn<DeviceBackend['installApp']>(async () => {}),
		launchApp: vi.fn<DeviceBackend['launchApp']>(async () => {}),
		stopApp: vi.fn<DeviceBackend['stopApp']>(async () => {}),
		clearAppData: vi.fn<DeviceBackend['clearAppData']>(async () => {}),
		screenshot: vi.fn<DeviceBackend['screenshot']>(async () => new Uint8Array([1, 2, 3])),
		readLogs: vi.fn<DeviceBackend['readLogs']>(async () => createMockLogRead()),
		pushFile: vi.fn<DeviceBackend['pushFile']>(async () => {}),
		pullFile: vi.fn<DeviceBackend['pullFile']>(async () => new Uint8Array([4, 5, 6])),
		readScreen: vi.fn<NonNullable<DeviceBackend['readScreen']>>(async () => []),
		tap: vi.fn<NonNullable<DeviceBackend['tap']>>(async () => {}),
		swipe: vi.fn<NonNullable<DeviceBackend['swipe']>>(async () => {}),
		typeText: vi.fn<NonNullable<DeviceBackend['typeText']>>(async () => {}),
		pressKey: vi.fn<NonNullable<DeviceBackend['pressKey']>>(async () => {}),
		setAirplaneMode: vi.fn<NonNullable<DeviceBackend['setAirplaneMode']>>(async () => {}),
		setWifiEnabled: vi.fn<NonNullable<DeviceBackend['setWifiEnabled']>>(async () => {}),
		recordVideo: vi.fn<NonNullable<DeviceBackend['recordVideo']>>(async () =>
			createMockRecordingBytes(),
		),
		...overrides,
	};
}

/**
 * The same surface as {@link createMockDeviceBackend}, built from plain async functions
 * with real bodies — the fixture the conformance harness
 * (`tests/helpers/backend-conformance.ts`) can actually read.
 *
 * A mock-built backend is invisible to every scan in that harness: `String(vi.fn(…))`
 * returns Vitest's wrapper source rather than the implementation, so a suite that used
 * {@link createMockDeviceBackend} as its "conforming" fixture would be proving nothing.
 * For the same reason no body here may be empty or return a bare empty literal — that is
 * precisely what the harness flags as a silent stub (ai/RULES.md §2).
 */
export function createConformingDeviceBackend(
	overrides: Partial<DeviceBackend> = {},
): DeviceBackend {
	const performed: string[] = [];

	return {
		async listDevices() {
			performed.push('listDevices');
			return [createMockDevice()];
		},
		// A real body, and one that delivers the first snapshot the contract promises: an
		// empty one — or a bare `{}` for a handle — is exactly what `isEmptyAnswerSource`
		// flags, and rightly, since it is what a backend that never implemented this looks
		// like.
		watchDevices(watcher: DeviceWatcher): DeviceWatch {
			performed.push('watchDevices');
			watcher.onDevices([createMockDevice()]);
			return {
				async stop() {
					performed.push('stopWatch');
				},
			};
		},
		async describeDevice(serial) {
			performed.push(`describeDevice ${serial}`);
			return createMockDevice({ serial });
		},
		async deviceInfo(serial) {
			performed.push(`deviceInfo ${serial}`);
			return createMockDeviceInfo({ serial });
		},
		async installApp(serial, packagePath) {
			performed.push(`installApp ${serial} ${packagePath}`);
		},
		async launchApp(serial, appId) {
			performed.push(`launchApp ${serial} ${appId}`);
		},
		async stopApp(serial, appId) {
			performed.push(`stopApp ${serial} ${appId}`);
		},
		async clearAppData(serial, appId) {
			performed.push(`clearAppData ${serial} ${appId}`);
		},
		async screenshot(serial) {
			performed.push(`screenshot ${serial}`);
			return new Uint8Array([1, 2, 3]);
		},
		async readLogs(serial, options) {
			performed.push(`readLogs ${serial} ${options.maxEntries}`);
			return createMockLogRead({
				entries: [createMockLogEntry({ message: `a line ${serial} printed` })],
			});
		},
		async pushFile(serial, hostPath, devicePath) {
			performed.push(`pushFile ${serial} ${hostPath} ${devicePath}`);
		},
		// Bytes that are neither empty nor all the same, so a body that lost or reordered them
		// fails a comparison — an empty array here is what the conformance harness flags, and
		// rightly, since it is what a backend that never implemented this looks like.
		async pullFile(serial, devicePath) {
			performed.push(`pullFile ${serial} ${devicePath}`);
			return new Uint8Array([4, 5, 6]);
		},
		async readScreen(serial) {
			performed.push(`readScreen ${serial}`);
			return [
				ScreenElementSchema.parse({
					id: `${serial}-root`,
					text: 'Root',
					label: null,
					bounds: { x: 0, y: 0, width: 100, height: 200 },
				}),
			];
		},
		async tap(serial, at) {
			performed.push(`tap ${serial} ${at.x},${at.y}`);
		},
		async swipe(serial, from, to, durationMs) {
			performed.push(`swipe ${serial} ${from.x},${from.y} ${to.x},${to.y} ${durationMs}`);
		},
		async typeText(serial, text) {
			performed.push(`typeText ${serial} ${text}`);
		},
		async pressKey(serial, key) {
			performed.push(`pressKey ${serial} ${key}`);
		},
		async setAirplaneMode(serial, enabled) {
			performed.push(`setAirplaneMode ${serial} ${enabled}`);
		},
		async setWifiEnabled(serial, enabled) {
			performed.push(`setWifiEnabled ${serial} ${enabled}`);
		},
		// A real body answering real bytes: an empty `Uint8Array` is what the harness flags as a
		// silent stub, and it is also what a recording pulled off a device that never started
		// looks like.
		async recordVideo(serial, options) {
			performed.push(`recordVideo ${serial} ${options.durationMs}`);
			return createMockRecordingBytes();
		},
		...overrides,
	};
}

export function createMockRegistration(
	overrides: Partial<DeviceBackendRegistration> = {},
): DeviceBackendRegistration {
	return {
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: createMockCapabilities(),
		},
		backend: createMockDeviceBackend(),
		...overrides,
	};
}

/**
 * What a verb is handed — the device, the backend that can act on it, and the manifest the
 * verb layer consults before it dispatches anything.
 *
 * A plain value here for the same reason it is one in production: the caller constructs it
 * (`src/daemon/verb-handlers.ts` does), and the verb layer never resolves a device itself.
 */
export function createMockVerbContext(overrides: Partial<VerbContext> = {}): VerbContext {
	return {
		serial: parseDeviceSerial('test-serial-1'),
		backend: createMockDeviceBackend(),
		manifest: createMockCapabilityManifest(),
		...overrides,
	};
}

/**
 * A {@link ProjectServices} for the suites that are not about helper services.
 *
 * The honest stand-in for a host where no project declares any: it starts nothing, has nothing
 * running and forgets nothing. `createLeaseHandlers` requires the real thing rather than
 * defaulting to this, because a grant that quietly started no services would be the false yes
 * the row exists to prevent (`src/daemon/project-services.ts`).
 */
export function createNoProjectServices(): ProjectServices {
	return {
		start: async () => null,
		startedFor: () => [],
		forget: () => {},
	};
}

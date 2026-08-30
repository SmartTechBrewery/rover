/**
 * The proof that the conformance gate works.
 *
 * `conformance.test.ts` runs over the registry, and the registry is empty until R5, so
 * on its own it is green and vacuous — the exact shape of "the gate arrived after the
 * first backend" that issue #3 exists to prevent. This file supplies the backends that
 * suite does not have yet: one that conforms, and one deliberate violation per rule,
 * each pinned to the checker that must catch it.
 *
 * Fixtures are built from `createConformingDeviceBackend()` rather than
 * `createMockDeviceBackend()` on purpose — a mock's source is Vitest's wrapper, which
 * every scan here would read as stub-free boilerplate (`tests/helpers/factories.ts`).
 *
 * The barrel is deliberately not imported: this file registers its own backends, and
 * Vitest isolates module state per file, so the gate's registrations are unaffected
 * either way.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisteredDeviceBackend } from '@/backends/manifest.js';
import {
	_resetDeviceBackendRegistryForTesting,
	listDeviceBackends,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Capabilities } from '@/core/capabilities.js';
import type {
	Device,
	DeviceBackend,
	DeviceInfo,
	DeviceWatch,
	DeviceWatcher,
	LogRead,
	ReadLogsOptions,
} from '@/core/device.js';
import { type AppId, type DeviceSerial, parsePlatformId } from '@/core/ids.js';
import {
	checkDeclaredCapabilitiesDispatch,
	checkManifestMetadata,
	checkNoStubbedMethods,
	checkRequiredMethods,
	checkUniquePlatformIds,
	collectConformanceViolations,
	isEmptyAnswerSource,
} from '../../helpers/backend-conformance.js';
import {
	createConformingDeviceBackend,
	createMockCapabilities,
	createMockCapabilityManifest,
	createMockDevice,
	createMockDeviceBackend,
	createMockDeviceInfo,
	createMockLogEntry,
} from '../../helpers/factories.js';

function registeredBackend(
	backend: DeviceBackend,
	capabilities: Partial<Capabilities> = {},
	platform = 'test-platform',
): RegisteredDeviceBackend {
	return {
		manifest: createMockCapabilityManifest({
			platform: parsePlatformId(platform),
			capabilities: createMockCapabilities(capabilities),
		}),
		backend,
	};
}

async function screenshotOffDevice(serial: DeviceSerial): Promise<Uint8Array> {
	return new Uint8Array([serial.length]);
}

/**
 * The shape the first real backend will take — a class, with its methods on the
 * prototype, declaring every capability it cannot do as `false`
 * (ai/CODING_STANDARDS.md "Module shape for a device backend"). Every scan here reads
 * `entry.backend[method]`, so this is the fixture that says prototype lookup and a
 * fully opted-out manifest are the passing case rather than an accident.
 */
class OptedOutBackend implements DeviceBackend {
	async listDevices(): Promise<Device[]> {
		return [createMockDevice()];
	}
	watchDevices(watcher: DeviceWatcher): DeviceWatch {
		watcher.onDevices([createMockDevice()]);
		return {
			stop: async () => {
				this.record('stopWatch');
			},
		};
	}
	async describeDevice(serial: DeviceSerial): Promise<Device | null> {
		return createMockDevice({ serial });
	}
	async deviceInfo(serial: DeviceSerial): Promise<DeviceInfo> {
		return createMockDeviceInfo({ serial });
	}
	async installApp(serial: DeviceSerial, packagePath: string): Promise<void> {
		this.record(`installApp ${serial} ${packagePath}`);
	}
	async launchApp(serial: DeviceSerial, appId: AppId): Promise<void> {
		this.record(`launchApp ${serial} ${appId}`);
	}
	async stopApp(serial: DeviceSerial, appId: AppId): Promise<void> {
		this.record(`stopApp ${serial} ${appId}`);
	}
	async clearAppData(serial: DeviceSerial, appId: AppId): Promise<void> {
		this.record(`clearAppData ${serial} ${appId}`);
	}
	async screenshot(serial: DeviceSerial): Promise<Uint8Array> {
		return screenshotOffDevice(serial);
	}
	async readLogs(serial: DeviceSerial, options: ReadLogsOptions): Promise<LogRead> {
		this.record(`readLogs ${serial} ${options.maxEntries}`);
		return {
			entries: [createMockLogEntry({ message: `a line ${serial} printed` })],
			truncated: false,
		};
	}

	private record(action: string): void {
		this.performed.push(action);
	}
	private readonly performed: string[] = [];
}

describe('a conforming backend', () => {
	it('reports no violations at all', () => {
		expect(
			collectConformanceViolations(registeredBackend(createConformingDeviceBackend())),
		).toEqual([]);
	});

	// The criterion this suite is sharpest about: an honest `false` is a *complete*
	// backend, not an unfinished one, so the absent method is not a violation
	// (ai/TESTING.md, D11).
	it('passes with an explicit opt-out and no method behind it', () => {
		const entry = registeredBackend(createConformingDeviceBackend({ readScreen: undefined }), {
			canReadScreen: false,
		});

		expect(collectConformanceViolations(entry)).toEqual([]);
	});

	it('passes as a class declaring no capability at all', () => {
		const entry = registeredBackend(new OptedOutBackend(), {
			canReadScreen: false,
			canInput: false,
			canControlNetwork: false,
		});

		expect(collectConformanceViolations(entry)).toEqual([]);
	});
});

describe('checkManifestMetadata', () => {
	it('accepts the metadata of a conforming manifest', () => {
		expect(checkManifestMetadata(registeredBackend(createConformingDeviceBackend()))).toEqual([]);
	});

	// The schema already rejects this at registration; the check is a second line,
	// because a flag that is not a boolean reads to the verb layer as an honest opt-out.
	it('reports a capability flag that is not a boolean', () => {
		const entry = {
			...registeredBackend(createConformingDeviceBackend()),
			manifest: {
				...createMockCapabilityManifest(),
				capabilities: { ...createMockCapabilities(), canInput: 'yes' },
			},
		} as unknown as RegisteredDeviceBackend;

		expect(checkManifestMetadata(entry)).toEqual([expect.stringContaining('canInput')]);
	});
});

describe('checkRequiredMethods', () => {
	it('reports a required method that is missing entirely', () => {
		const entry = registeredBackend(createConformingDeviceBackend({ clearAppData: undefined }));

		expect(checkRequiredMethods(entry)).toEqual([expect.stringContaining('clearAppData')]);
	});
});

describe('checkDeclaredCapabilitiesDispatch', () => {
	it('reports a declared capability with nothing to dispatch to', () => {
		const entry = registeredBackend(createConformingDeviceBackend({ tap: undefined }), {
			canInput: true,
		});

		const violations = checkDeclaredCapabilitiesDispatch(entry);
		expect(violations).toEqual([expect.stringContaining('tap')]);
		expect(violations[0]).toContain('canInput');
	});

	it('reports every unanswered method of a declared capability, not just the first', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({ setAirplaneMode: undefined, setWifiEnabled: undefined }),
			{ canControlNetwork: true },
		);

		expect(checkDeclaredCapabilitiesDispatch(entry)).toHaveLength(2);
	});

	it('says nothing about a capability declared false', () => {
		const entry = registeredBackend(createConformingDeviceBackend({ readScreen: undefined }), {
			canReadScreen: false,
		});

		expect(checkDeclaredCapabilitiesDispatch(entry)).toEqual([]);
	});
});

describe('checkNoStubbedMethods', () => {
	it('reports a method carrying the not-implemented sentinel', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({
				async launchApp(serial, appId) {
					throw new Error(`launchApp(${serial}, ${appId}) is not implemented yet`);
				},
			}),
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('sentinel')]);
	});

	it('reports the sentinel however it is worded', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({
				async readScreen() {
					throw new Error('readScreen is not implemented for this backend');
				},
			}),
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('readScreen')]);
	});

	// The stub that never says it is one — the failure ai/RULES.md §2 names, and the
	// reason the scan reads the body rather than only searching for the sentinel.
	it('reports a method that answers with an empty list', () => {
		const entry = registeredBackend(createConformingDeviceBackend({ readScreen: async () => [] }));

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('empty result')]);
	});

	// The one empty answer that *cannot* drop its parentheses: a concise arrow body
	// returning an object literal needs them to parse. Written end to end rather than
	// against `isEmptyAnswerSource` alone because this is the form that survives the
	// transform Vitest reads the source through.
	it('reports a method that answers with an empty object behind parentheses', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({
				describeDevice: async () => ({}) as unknown as Device,
			}),
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('describeDevice')]);
	});

	it('reports a method that answers with empty bytes', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({ screenshot: async () => new Uint8Array() }),
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('screenshot')]);
	});

	it('reports a method whose body does nothing at all', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({
				async stopApp() {},
			}),
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('stopApp')]);
	});

	// An opt-out's method is scanned rather than skipped: `canReadScreen: false` beside a
	// `readScreen` that throws the sentinel is a backend under construction, not a
	// backend that made a choice (ai/TESTING.md).
	it('reports a stub behind a capability declared false', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({
				async readScreen() {
					throw new Error('not implemented');
				},
			}),
			{ canReadScreen: false },
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('sentinel')]);
	});

	it('reports a mock, whose wrapper source hides whatever it wraps', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({
				listDevices: vi.fn<DeviceBackend['listDevices']>(async () => []),
			}),
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('unreadable')]);
	});

	it('reports a bound function, whose source is native', () => {
		const entry = registeredBackend(
			createConformingDeviceBackend({ screenshot: screenshotOffDevice.bind(null) }),
		);

		expect(checkNoStubbedMethods(entry)).toEqual([expect.stringContaining('unreadable')]);
	});

	// Guards the fixture itself: were the whole mock backend readable, every suite above
	// that builds on `createConformingDeviceBackend` would be proving something weaker
	// than it claims.
	it('reports every method of a fully mocked backend', () => {
		const entry = registeredBackend(createMockDeviceBackend());

		expect(checkNoStubbedMethods(entry)).toHaveLength(17);
	});
});

describe('isEmptyAnswerSource', () => {
	it.each([
		['a concise arrow returning an empty list', 'async () => []'],
		['a block body returning an empty object', 'async function f() { return {}; }'],
		['a method returning null', 'async describeDevice(serial) { return null; }'],
		['an empty body', 'async stopApp(serial, appId) {}'],
		['a body that is only a comment', 'async stopApp() { /* TODO */ }'],
		['a concise arrow returning a parenthesized empty list', 'async () => ([])'],
		['a concise arrow returning a parenthesized empty object', 'async () => ({})'],
		['a block body returning a parenthesized empty list', 'async readScreen() { return ([]); }'],
		['a parenthesized empty byte array', 'async screenshot() { return (new Uint8Array()); }'],
		['redundantly nested parentheses', 'async readScreen() { return ((([]))); }'],
	])('flags %s', (_name, source) => {
		expect(isEmptyAnswerSource(source)).toBe(true);
	});

	it.each([
		['work before the return', 'async readScreen(s) { const x = await read(s); return x; }'],
		['a non-empty literal', 'async screenshot() { return new Uint8Array([1]); }'],
		['a loud failure', "async tap() { throw new MissingCapabilityError('canInput'); }"],
		['a delegated call', 'async listDevices() { return this.enumerate(); }'],
		['a parenthesized await', 'async listDevices() { return (await this.enumerate()); }'],
		// Guards the paren stripping itself: these parens do not wrap the whole
		// expression, so dropping them would leave a fragment that reads as empty.
		['parens around each half of a sum', 'async count() { return ([].length) + (this.n); }'],
	])('leaves %s alone', (_name, source) => {
		expect(isEmptyAnswerSource(source)).toBe(false);
	});
});

describe('checkUniquePlatformIds', () => {
	it('reports two registrations sharing a platform id', () => {
		const backend = createConformingDeviceBackend();

		expect(
			checkUniquePlatformIds([
				registeredBackend(backend, {}, 'platform-one'),
				registeredBackend(backend, {}, 'platform-one'),
			]),
		).toEqual([expect.stringContaining('platform-one')]);
	});

	it('says nothing about distinct platform ids', () => {
		const backend = createConformingDeviceBackend();

		expect(
			checkUniquePlatformIds([
				registeredBackend(backend, {}, 'platform-one'),
				registeredBackend(backend, {}, 'platform-two'),
			]),
		).toEqual([]);
	});
});

/**
 * The registry-driven path — "one run per **registered** manifest" — exercised with a
 * non-empty registry, which is the only way to prove it before a real backend exists.
 */
describe('the registry-driven gate', () => {
	beforeEach(() => {
		_resetDeviceBackendRegistryForTesting();
	});

	it('produces one verdict per registered manifest', () => {
		registerDeviceBackend({
			manifest: { platform: 'platform-one', label: 'One', capabilities: createMockCapabilities() },
			backend: createConformingDeviceBackend(),
		});
		registerDeviceBackend({
			manifest: { platform: 'platform-two', label: 'Two', capabilities: createMockCapabilities() },
			backend: createConformingDeviceBackend({
				async installApp() {
					throw new Error('installApp is not implemented yet');
				},
			}),
		});

		const verdicts = listDeviceBackends().map((entry) => collectConformanceViolations(entry));

		expect(verdicts).toHaveLength(2);
		expect(verdicts[0]).toEqual([]);
		expect(verdicts[1]).toEqual([expect.stringContaining('platform-two.installApp')]);
	});
});

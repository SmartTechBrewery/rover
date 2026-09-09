import { beforeEach, describe, expect, it } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	describeHostTooling,
	getDeviceBackend,
	installHostTool,
	listDeviceBackends,
	registerDeviceBackend,
	requireDeviceBackend,
	stopBackendHostProcesses,
	UninstallableToolError,
} from '@/backends/registry.js';
import { parsePlatformId } from '@/core/ids.js';
import { createMockCapabilities, createMockRegistration } from '../../helpers/factories.js';

const platform = parsePlatformId('test-platform');

beforeEach(() => {
	_resetDeviceBackendRegistryForTesting();
});

describe('registerDeviceBackend', () => {
	it('round-trips a registration through get and list', () => {
		const registration = createMockRegistration();

		registerDeviceBackend(registration);

		const registered = getDeviceBackend(platform);
		expect(registered?.backend).toBe(registration.backend);
		expect(registered?.manifest.label).toBe('Test');
		expect(listDeviceBackends()).toEqual([registered]);
	});

	it('stores the parsed manifest, not the input object', () => {
		const registration = createMockRegistration();

		registerDeviceBackend(registration);

		expect(getDeviceBackend(platform)?.manifest).not.toBe(registration.manifest);
	});

	it('rejects a duplicate platform id', () => {
		registerDeviceBackend(createMockRegistration());

		expect(() => registerDeviceBackend(createMockRegistration())).toThrow(/already registered/);
	});

	it.each([
		['an unknown capability flag', { ...createMockCapabilities(), canFly: true }],
		['a non-boolean capability flag', { ...createMockCapabilities(), canInput: 'yes' }],
		['a missing capability flag', { canReadScreen: true, canInput: true }],
	])('rejects %s at registration', (_name, capabilities) => {
		const registration = createMockRegistration();

		expect(() =>
			registerDeviceBackend({
				...registration,
				// The schema is the source of truth, so an invalid manifest never reaches the
				// registry — the cast is only to get past the compile-time shape the test is probing.
				manifest: { ...registration.manifest, capabilities } as never,
			}),
		).toThrow();
		expect(listDeviceBackends()).toEqual([]);
	});
});

describe('getDeviceBackend', () => {
	it('returns null for a platform nothing registered', () => {
		expect(getDeviceBackend(parsePlatformId('nothing-registered'))).toBeNull();
	});
});

describe('requireDeviceBackend', () => {
	it('returns the registration when one exists', () => {
		const registration = createMockRegistration();
		registerDeviceBackend(registration);

		expect(requireDeviceBackend(platform).backend).toBe(registration.backend);
	});

	it('throws pointing at the barrel, since a miss is a wiring bug', () => {
		expect(() => requireDeviceBackend(platform)).toThrow(/src\/backends\/index\.ts/);
	});
});

describe('listDeviceBackends', () => {
	it('returns a clone a caller cannot splice the registry through', () => {
		registerDeviceBackend(createMockRegistration());

		const listed = listDeviceBackends() as ReturnType<typeof listDeviceBackends>[number][];
		listed.length = 0;

		expect(listDeviceBackends()).toHaveLength(1);
	});
});

describe('stopBackendHostProcesses', () => {
	it('calls the teardown of every backend that registered one', async () => {
		const stopped: string[] = [];
		registerDeviceBackend(
			createMockRegistration({
				stopHostProcesses: async () => {
					stopped.push('first');
				},
			}),
		);
		registerDeviceBackend(
			createMockRegistration({
				manifest: {
					platform: 'second-platform',
					label: 'Second',
					capabilities: createMockCapabilities(),
				},
				stopHostProcesses: async () => {
					stopped.push('second');
				},
			}),
		);

		await stopBackendHostProcesses();

		expect([...stopped].sort()).toEqual(['first', 'second']);
	});

	// Android is this backend: no process of its own between calls, so no teardown to register
	// and nothing here to skip it by. The absence has to be a no-op rather than a crash, because
	// it is the shape most backends will have.
	it('skips a backend that registered no teardown', async () => {
		registerDeviceBackend(createMockRegistration());

		await expect(stopBackendHostProcesses()).resolves.toBeUndefined();
	});

	it('is a no-op on an empty registry', async () => {
		await expect(stopBackendHostProcesses()).resolves.toBeUndefined();
	});

	// The whole point of `allSettled` here: this runs on the way down, and one backend holding on
	// to its children is not a reason to abandon the others or to reject a shutdown step.
	it('warns naming the platform and still stops the others when one teardown rejects', async () => {
		const warnings: string[] = [];
		let stoppedSecond = false;
		registerDeviceBackend(
			createMockRegistration({
				stopHostProcesses: () => Promise.reject(new Error('companion would not die')),
			}),
		);
		registerDeviceBackend(
			createMockRegistration({
				manifest: {
					platform: 'second-platform',
					label: 'Second',
					capabilities: createMockCapabilities(),
				},
				stopHostProcesses: async () => {
					stoppedSecond = true;
				},
			}),
		);

		await stopBackendHostProcesses(listDeviceBackends(), (message) => warnings.push(message));

		expect(stoppedSecond).toBe(true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('test-platform');
		expect(warnings[0]).toContain('companion would not die');
	});
});

describe('describeHostTooling', () => {
	/**
	 * The row arrives tagged with the platform that reported it, and the provider never says its
	 * own name — so two backends that each need one program still produce rows a reader can tell
	 * apart, and no provider can mislabel another's.
	 */
	it('tags every row with the backend that reported it', async () => {
		registerDeviceBackend(
			createMockRegistration({
				hostTooling: {
					describe: async () => [
						{ tool: 'thing', found: '/usr/bin/thing', detail: 'From PATH.', installable: false },
					],
				},
			}),
		);

		await expect(describeHostTooling()).resolves.toEqual([
			{
				platform: 'test-platform',
				tool: 'thing',
				found: '/usr/bin/thing',
				detail: 'From PATH.',
				installable: false,
			},
		]);
	});

	/** A backend that registered no provider is skipped, not reported as empty. */
	it('skips a backend that declares no tooling', async () => {
		registerDeviceBackend(createMockRegistration());

		await expect(describeHostTooling()).resolves.toEqual([]);
	});

	/**
	 * A report is not a place to be silent about a failure (ai/RULES.md §6), and a doctor that died
	 * on one backend would tell an operator nothing about the other — which is the row they came
	 * for.
	 */
	it('turns a provider that threw into a row saying so, rather than rejecting', async () => {
		registerDeviceBackend(
			createMockRegistration({
				hostTooling: {
					describe: async () => {
						throw new Error('the search itself broke');
					},
				},
			}),
		);

		const [row] = await describeHostTooling();

		expect(row?.found).toBeNull();
		expect(row?.detail).toContain('the search itself broke');
		expect(row?.installable).toBe(false);
	});
});

describe('installHostTool', () => {
	it('routes to the backend that offered that program, and tags the answer', async () => {
		registerDeviceBackend(
			createMockRegistration({
				hostTooling: {
					describe: async () => [
						{ tool: 'thing', found: null, detail: 'missing', installable: true },
					],
					install: async (tool: string) => ({
						tool,
						found: '/installed/thing',
						detail: `Installed ${tool}.`,
						installable: true,
					}),
				},
			}),
		);

		await expect(installHostTool('thing')).resolves.toEqual({
			platform: 'test-platform',
			tool: 'thing',
			found: '/installed/thing',
			detail: 'Installed thing.',
			installable: true,
		});
	});

	/**
	 * A program a backend reports but declares uninstallable is the honest answer for `adb` and for
	 * Xcode — Rover fetches its own second-order tooling and never a platform SDK — so asking for
	 * one is refused rather than dispatched.
	 */
	it('refuses a program nothing offered to install, naming it', async () => {
		registerDeviceBackend(
			createMockRegistration({
				hostTooling: {
					describe: async () => [
						{ tool: 'adb', found: null, detail: 'missing', installable: false },
					],
					install: async () => {
						throw new Error('should never be reached');
					},
				},
			}),
		);

		await expect(installHostTool('adb')).rejects.toBeInstanceOf(UninstallableToolError);
	});
});

describe('_resetDeviceBackendRegistryForTesting', () => {
	it('clears both the list and the lookup', () => {
		registerDeviceBackend(createMockRegistration());

		_resetDeviceBackendRegistryForTesting();

		expect(listDeviceBackends()).toEqual([]);
		expect(getDeviceBackend(platform)).toBeNull();
	});
});

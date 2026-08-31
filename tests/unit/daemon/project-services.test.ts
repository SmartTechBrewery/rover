/**
 * `createProjectServices` over a real hook file and real child processes (D13, R17 phase 4).
 *
 * **What is asserted here is the false-yes rule** (`ai/RULES.md` §2): a start that fails must
 * refuse the grant *by name*, and everything that grant had already brought up must be down
 * again before the refusal is answered. A module that started three services, failed on the
 * fourth and reported success would hand a caller a lease on a device whose helper services
 * are half up — the plausible-looking answer the rule forbids.
 *
 * The other half is the per-lease record: what the daemon started is remembered for exactly as
 * long as the lease it belongs to, and `forget` — the lease store's end hook — is what drops it
 * (`src/daemon/archive.ts`'s counters are the precedent). A host that kept one entry per lease
 * it had ever granted would grow forever.
 *
 * Real child processes rather than a mocked `spawn`, for `./hook-command.test.ts`'s reason: the
 * order services came up and went down in is a thing programs did, and a mocked spawn would
 * assert an options object instead. Each hook appends one line to a shared log file, so the
 * whole sequence is one readable list rather than four call counts.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_COMMAND_TIMEOUT_MS } from '@/daemon/hook-command.js';
import type { Lease } from '@/daemon/leases.js';
import { MAX_PROJECT_SERVICES } from '@/daemon/project-hooks.js';
import {
	createProjectServices,
	type ProjectServices,
	SERVICE_START_TIMEOUT_MS,
} from '@/daemon/project-services.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@/ipc/client.js';
import { createMockLease } from '../../helpers/factories.js';

const PROJECT = 'checkout-web';

let root: string;
let log: string;
let lease: Lease;
let warnings: string[];

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'rover-services-'));
	log = join(root, 'services.log');
	lease = createMockLease({ project: PROJECT });
	warnings = [];
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

/** A hook that appends `what`, and the project and device it was told about, to the log. */
function record(what: string): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: [
			'-e',
			"require('node:fs').appendFileSync(process.argv[1], process.argv[2] + ' ' + " +
				"process.env.ROVER_PROJECT + ' ' + process.env.ROVER_DEVICE_SERIAL + '\\n')",
			log,
			what,
		],
	};
}

/** A hook that says something on stderr and exits non-zero — a service that would not come up. */
function refuse(why: string): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: ['-e', `process.stderr.write(${JSON.stringify(why)}); process.exit(3)`],
	};
}

/** A hook that has started and will not stop on its own. */
const NEVER_EXITS = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

async function writeHookFile(contents: unknown): Promise<void> {
	await writeFile(
		join(root, `${PROJECT}.json`),
		typeof contents === 'string' ? contents : JSON.stringify(contents),
		'utf8',
	);
}

function services(
	overrides: { hookTimeoutMs?: number; startTimeoutMs?: number; now?: () => number } = {},
): ProjectServices {
	return createProjectServices({
		root,
		warn: (message) => warnings.push(message),
		...overrides,
	});
}

/** Every line the hooks appended, in the order they appended it. */
async function performed(): Promise<string[]> {
	const contents = await readFile(log, 'utf8').catch(() => '');
	return contents.split('\n').filter((line) => line !== '');
}

describe('a grant starts what the project declares', () => {
	it('starts them in declaration order, telling each which project and device', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: record('start-db'), stop: record('stop-db') },
				{ name: 'api', start: record('start-api'), stop: record('stop-api') },
			],
		});

		await expect(services().start(lease)).resolves.toBeNull();

		// Declaration order, and each was told what a hook cannot know for itself — a service
		// started against the wrong device is the failure `ROVER_DEVICE_SERIAL` exists for.
		expect(await performed()).toEqual([
			`start-db ${PROJECT} ${lease.serial}`,
			`start-api ${PROJECT} ${lease.serial}`,
		]);
		expect(warnings).toEqual([]);
	});

	it('starts nothing for a project with no hook file, and refuses nothing', async () => {
		const registry = services();

		// A project nobody has described is the ordinary state of a host, not a failure.
		await expect(registry.start(lease)).resolves.toBeNull();
		expect(registry.startedFor(lease)).toEqual([]);
	});

	it('starts nothing for a project whose file declares no services', async () => {
		await writeHookFile({ project: PROJECT, apps: ['com.example.checkout'] });

		await expect(services().start(lease)).resolves.toBeNull();
		expect(await performed()).toEqual([]);
	});

	it('re-reads the file on every grant, so an edit needs no restart', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [{ name: 'db', start: record('start-db') }],
		});
		const registry = services();
		await registry.start(lease);

		await writeHookFile({
			project: PROJECT,
			services: [{ name: 'api', start: record('start-api') }],
		});
		await registry.start(createMockLease({ project: PROJECT, id: 'lease-2' as Lease['id'] }));

		// D6: nothing is cached, so the next lease on this project starts what the file says now.
		expect(await performed()).toEqual([
			`start-db ${PROJECT} ${lease.serial}`,
			`start-api ${PROJECT} ${lease.serial}`,
		]);
	});
});

describe('a service that will not start', () => {
	it('refuses by name, quoting what the program said', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [{ name: 'db', start: refuse('the port is already taken') }],
		});

		const refusal = await services().start(lease);

		// By name, because "a service failed" tells an agent nothing it can go and look at.
		expect(refusal?.service).toBe('db');
		expect(refusal?.message).toContain("'db'");
		expect(refusal?.message).toContain(PROJECT);
		expect(refusal?.message).toContain(lease.serial);
		expect(refusal?.message).toContain('the port is already taken');
	});

	it('stops what it had already started, newest first, and says so in the refusal', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: record('start-db'), stop: record('stop-db') },
				{ name: 'cache', start: record('start-cache'), stop: record('stop-cache') },
				{ name: 'api', start: refuse('the api would not bind'), stop: record('stop-api') },
			],
		});

		const refusal = await services().start(lease);

		// The grant is not happening, so nothing it brought up may be left running — and the
		// reverse order is what lets a project declare a database before the thing that uses it.
		expect(await performed()).toEqual([
			`start-db ${PROJECT} ${lease.serial}`,
			`start-cache ${PROJECT} ${lease.serial}`,
			`stop-cache ${PROJECT} ${lease.serial}`,
			`stop-db ${PROJECT} ${lease.serial}`,
		]);
		expect(refusal?.message).toContain("'cache', 'db' services started for this grant were");
	});

	it('keeps no record of a grant it refused', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: record('start-db'), stop: record('stop-db') },
				{ name: 'api', start: refuse('no') },
			],
		});
		const registry = services();

		await registry.start(lease);

		// The lease is about to be released by the handler; a record of services that are down
		// would outlive both the grant and the truth.
		expect(registry.startedFor(lease)).toEqual([]);
	});

	it('warns and carries on when the rollback stop itself fails', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: record('start-db'), stop: refuse('the container was already gone') },
				{ name: 'api', start: refuse('no') },
			],
		});

		const refusal = await services().start(lease);

		// A stop that failed must not take the refusal with it: the caller still has to be told
		// which service refused, and the host operator still has to hear about the leak.
		expect(refusal?.service).toBe('api');
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("'db'");
		expect(warnings[0]).toContain('may still be running');
	});

	it('refuses when the hook file itself will not parse, naming the project', async () => {
		await writeHookFile('{ "project": "checkout-web", ');

		const refusal = await services().start(lease);

		// A file the host cannot read is a file whose services it cannot start, so granting
		// would be the false yes this module exists to prevent. There is no service to name.
		expect(refusal?.service).toBeNull();
		expect(refusal?.message).toContain(PROJECT);
		expect(refusal?.message).toContain('is not valid JSON');
	});
});

describe('the budget the whole start phase shares', () => {
	it('sits under the request timeout a client waits out, and above one command', () => {
		// Asserted rather than left to drift, the way `HOOK_COMMAND_TIMEOUT_MS` is asserted
		// against the restorer's bound. `acquire_device` is the one call no client raises its own
		// timeout for, and a grant answered after the caller gave up holds the device for a full
		// `LEASE_TTL_MS` with nobody there to release it. It is the bound on the *whole* phase,
		// the refusal path included, so it is the number a `'service-failed'` answer arrives
		// inside — which is the only reason that answer reaches the agent at all rather than as
		// a request timeout with no service named.
		expect(SERVICE_START_TIMEOUT_MS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
		expect(SERVICE_START_TIMEOUT_MS).toBeGreaterThan(HOOK_COMMAND_TIMEOUT_MS);
		// And the reason there is a phase bound at all rather than only a per-command one: the
		// per-command bound, spent by every service a project may declare, is far past what a
		// client will wait. A day when this stops being true is a day the phase bound could be
		// dropped, and it should be dropped deliberately rather than by arithmetic.
		expect(MAX_PROJECT_SERVICES * HOOK_COMMAND_TIMEOUT_MS).toBeGreaterThan(
			DEFAULT_REQUEST_TIMEOUT_MS,
		);
	});

	it('kills a start that outlives it and refuses by name', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [{ name: 'db', start: NEVER_EXITS }],
		});

		// The seam exists because the real bound is twenty seconds and no unit test may wait it
		// out. What it protects is the *client*: `acquire_device` is the one call nobody raises
		// their request timeout for.
		const refusal = await services({ startTimeoutMs: 25 }).start(lease);

		expect(refusal?.service).toBe('db');
		expect(refusal?.message).toContain('25ms budget');
	});

	it('lets a start killed at the budget stop the ones after it from being reached', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: NEVER_EXITS, stop: record('stop-db') },
				{ name: 'api', start: record('start-api') },
			],
		});

		const refusal = await services({ startTimeoutMs: 25 }).start(lease);

		// `db` is the one that spent the budget, so it is the one named; `api` was never spawned.
		expect(refusal?.service).toBe('db');
		expect(await performed()).toEqual([]);
	});

	it('refuses the service the budget never reached, with nothing spawned for it', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: record('start-db') },
				{ name: 'api', start: record('start-api') },
				{ name: 'cache', start: record('start-cache') },
			],
		});

		// This is the branch a *successful* start reaches, and a real clock cannot arrange it
		// without racing: each command's own bound is already capped by what is left of the phase,
		// so a start that outlives the budget is a killed start (the case above) rather than a
		// spent one. So the phase's clock is moved by hand — a second per reading, the way
		// `leases.test.ts` moves a TTL — and the child processes stay real.
		let nowMs = 0;
		const refusal = await services({
			startTimeoutMs: 3_000,
			hookTimeoutMs: 9_000,
			now: () => (nowMs += 1_000),
		}).start(lease);

		// Two starts got a share of the budget and succeeded; the third is refused *by name*
		// rather than spawned with nothing left to finish in, which is the honest answer — a
		// command started with no time is a command that will be killed and reported as a failure
		// the project did not commit.
		expect(refusal?.service).toBe('cache');
		expect(refusal?.message).toContain('was spent before it was reached');
		expect(await performed()).toEqual([
			`start-db ${PROJECT} ${lease.serial}`,
			`start-api ${PROJECT} ${lease.serial}`,
		]);
	});

	it('rolls a refused grant back inside it, warning about a stop it had no time for', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: record('start-db'), stop: record('stop-db') },
				{ name: 'cache', start: record('start-cache'), stop: record('stop-cache') },
				{ name: 'api', start: refuse('the api would not bind') },
			],
		});

		// The clock is moved by hand for the case above's reason. What it pins is that the
		// rollback draws on the *same* budget the starts did: a fresh bound per stop would let a
		// project with several slow `stop` commands answer `'service-failed'` after the client's
		// 30 s request timeout had already turned it into an opaque host error — losing the one
		// thing the refusal is for, the name of the service to go and look at.
		let nowMs = 0;
		const refusal = await services({
			startTimeoutMs: 5_000,
			hookTimeoutMs: 9_000,
			now: () => (nowMs += 1_000),
		}).start(lease);

		expect(refusal?.service).toBe('api');
		// `cache` came up last, so it went down first, and there was still budget for it.
		expect(refusal?.message).toContain("The 'cache' service started for this grant was stopped");
		expect(await performed()).toEqual([
			`start-db ${PROJECT} ${lease.serial}`,
			`start-cache ${PROJECT} ${lease.serial}`,
			`stop-cache ${PROJECT} ${lease.serial}`,
		]);
		// And `db`'s stop was not tried at all rather than spawned past the bound. It is a leak,
		// said out loud: the operator hears which service may still be running, and the agent
		// still gets the refusal naming what would not start.
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("'db'");
		expect(warnings[0]).toContain('was not tried');
		expect(warnings[0]).toContain('may still be running');
	});
});

describe('what a lease has running', () => {
	it('is remembered for the lease and dropped when it ends', async () => {
		await writeHookFile({
			project: PROJECT,
			services: [
				{ name: 'db', start: record('start-db'), stop: record('stop-db') },
				{ name: 'api', start: record('start-api') },
			],
		});
		const registry = services();
		await registry.start(lease);

		// Both, including the one with no `stop`: what is running is not the same question as
		// what there is a command to stop.
		expect(registry.startedFor(lease)).toEqual(['db', 'api']);

		registry.forget(lease);

		// The lease store's end hook, and it undoes nothing on the host — the restoration is
		// what stops these, from the hook file. This is the growth bound and nothing else.
		expect(registry.startedFor(lease)).toEqual([]);
		expect(await performed()).toEqual([
			`start-db ${PROJECT} ${lease.serial}`,
			`start-api ${PROJECT} ${lease.serial}`,
		]);
	});
});

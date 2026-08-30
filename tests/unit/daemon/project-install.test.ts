/**
 * `createProjectInstall` over a real hook file and real child processes (D13, R17 phase 3).
 *
 * The two suites here are the ones the daemon-level tests cannot reach, and both are about a
 * hook that does **not** finish immediately — which is the shape a real project's install
 * actually has. `tests/unit/daemon/verb-dispatch.test.ts` covers the endings that arrive at
 * once (a project nobody registered, a file declaring no `install`, an unparseable file, a
 * command that exits non-zero); this covers the two ways a run is *ended from outside* — its
 * own budget, and the lease that asked for it going away — and that each is named differently
 * in what reaches the agent. Both arrive with no exit code and the same signal, so the wording
 * is the only thing telling an operator whether to look at the build or at the caller.
 *
 * Real processes for `./hook-command.test.ts`'s reason: what is under test is a program being
 * killed, and a mocked `spawn` would assert an options object instead.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDeviceSerial } from '@/core/ids.js';
import { createProjectInstall } from '@/daemon/project-install.js';
import { InstallHookFailedError } from '@/verbs/errors.js';

const SERIAL = parseDeviceSerial('attached-1');
const PROJECT = 'checkout-web';

/** A build that has started and will not stop on its own — every ending here comes from outside. */
const NEVER_EXITS = ['-e', 'setInterval(() => {}, 1000)'];

let root: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'rover-install-'));
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

async function writeHookFile(install: { command: string; args: string[] }): Promise<void> {
	await writeFile(
		join(root, `${PROJECT}.json`),
		JSON.stringify({ project: PROJECT, apps: [], install }),
		'utf8',
	);
}

/** Run the install and hand back the named failure it is asserted to be. */
async function failureOf(run: () => Promise<void>): Promise<InstallHookFailedError> {
	const error = await run().then(
		() => null,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(InstallHookFailedError);
	return error as InstallHookFailedError;
}

describe('an install that outlives its budget', () => {
	it('kills it and answers with a named failure saying the budget is why', async () => {
		await writeHookFile({ command: process.execPath, args: NEVER_EXITS });
		// The seam `ProjectInstallOptions.hookTimeoutMs` exists for: the real bound is five
		// minutes, and this is the one branch a real build is most likely to reach in anger.
		const install = createProjectInstall({ root, hookTimeoutMs: 25 });

		const failure = await failureOf(() => install(PROJECT, SERIAL));

		// No exit code and a signal, which is what an agent has to be able to tell apart from a
		// build that failed on its own merits — so `outcome` carries the runner's own words.
		expect(failure.exitCode).toBeNull();
		expect(failure.signal).toBe('SIGKILL');
		expect(failure.outcome).toContain('25ms budget');
		expect(failure.project).toBe(PROJECT);
		expect(failure.serial).toBe(SERIAL);
		expect(failure.command).toBe(process.execPath);
	});
});

describe('an install whose lease ends underneath it', () => {
	it('kills it at once rather than waiting out the budget', async () => {
		await writeHookFile({ command: process.execPath, args: NEVER_EXITS });
		// The real five-minute bound, deliberately: what is under test is that the *signal* ends
		// this run, and a short budget would let the wrong one of the two win.
		const install = createProjectInstall({ root });
		const cancel = new AbortController();

		const failing = failureOf(() => install(PROJECT, SERIAL, cancel.signal));
		cancel.abort();
		const failure = await failing;

		expect(failure.signal).toBe('SIGKILL');
		// Not the budget's words: a build stopped because its caller went away sends whoever
		// reads this to the lease, and "its 300000ms budget is the likely reason" would send
		// them to a build log for a failure that never happened.
		expect(failure.outcome).toContain('the lease that asked for it ended');
		expect(failure.outcome).not.toContain('budget');
	});

	it('never starts one whose lease had already ended', async () => {
		await writeHookFile({ command: process.execPath, args: NEVER_EXITS });
		const install = createProjectInstall({ root });

		const failure = await failureOf(() => install(PROJECT, SERIAL, AbortSignal.abort()));

		expect(failure.outcome).toContain('the lease that asked for it ended');
	});
});

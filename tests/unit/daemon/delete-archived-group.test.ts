/**
 * `delete_archived_group` — **the runs whose group id matches, and nothing else** (D43, R51 phase 3,
 * #277).
 *
 * Over a real temp tree with known byte counts, a real `ArchiveSweeper` and a real kept-tests
 * store, in `measure-archive-groups.test.ts`' idiom and for its reasons: what this method does *is*
 * files somebody can list, and for a method whose whole job is deletion that is not a convention to
 * bend. Nothing here goes near `~/.rover` — every root is under one `mkdtemp` (`ai/TESTING.md`).
 *
 * **The handler is driven directly rather than over a socket**, which is that suite's own
 * arrangement rather than `delete-archived-test.test.ts`'s. Three of the claims here need a seam a
 * socket does not offer: the injected `warn` and `audit`, which is the only way to assert that the
 * path and the reason are on the **log** and not on the answer (D19); the injected `liveLeases`,
 * which is how a lease filing into a matched run is arranged without a device backend; and the
 * directory bound, which is how a truncated walk is asserted without making five thousand
 * directories. The `.strict()` parse a socket would have given is kept by parsing **both** wire
 * schemas on every call below, so nothing here asserts on a shape the host could not send or
 * receive.
 *
 * The claims a reviewer would otherwise take on trust, all of them D43's:
 *
 * - only the runs of the group go, and a test's runs of another group or of none stay;
 * - a test the deletion **empties** is removed and only then is its kept entry pruned;
 * - a test left standing keeps its runs **and its `Keep`**;
 * - a group nothing named is `not-found` and never a success that removed nothing;
 * - a run the host will not remove is `partial` with the rest reported;
 * - a walk that was **cut short** is `partial` and never `deleted`;
 * - a live lease on one matched run refuses the call with **nothing** touched;
 * - a group id carrying a separator, a NUL or a newline is matched as content, never as a path.
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { leaseRunDirectory } from '@/daemon/archive-path.js';
import { createArchiveSweeper } from '@/daemon/archive-sweep.js';
import {
	createDeleteArchivedGroupHandler,
	type DeleteArchivedGroupHandler,
} from '@/daemon/delete-archived-group.js';
import { type KeptTest, readKeptTests, writeKeptTests } from '@/daemon/kept-tests.js';
import type { Lease } from '@/daemon/leases.js';
import {
	type DeleteArchivedGroupParams,
	DeleteArchivedGroupParamsSchema,
	type DeleteArchivedGroupResult,
	DeleteArchivedGroupResultSchema,
} from '@/ipc/methods.js';
import { createMockLease } from '../../helpers/factories.js';

/** The runs the seeded tree holds — spelled the way the archive spells one. */
const RUN_A = '20260901T101500Z-issue-1-aaaaaaaa';
const RUN_B = '20260902T101500Z-issue-2-bbbbbbbb';
const RUN_C = '20260903T101500Z-issue-3-cccccccc';
const RUN_D = '20260904T101500Z-issue-4-dddddddd';
const RUN_E = '20260905T101500Z-issue-5-eeeeeeee';

/** The group under test, a second one under the same project, and one nothing ever named. */
const GROUP = 'app-bar-top-space';
const OTHER_GROUP = 'basket-total';
const UNUSED_GROUP = 'nobody-named-this';

/** Every size is a distinct number, so no assertion can pass on the wrong sum by luck. */
const SHOT_A = 100;
const CLIP_A = 250;
const SHOT_B = 40;
const SHOT_C = 7;
const SHOT_D = 13;
const SHOT_E = 3_000;

/** One `group_id.json`, as a lease writes it — and the bytes it adds to its own run's subtree. */
function groupIdFileBytes(groupId: string): number {
	return JSON.stringify({ groupId }).length;
}

const RUN_A_BYTES = SHOT_A + CLIP_A + groupIdFileBytes(GROUP);
const RUN_B_BYTES = SHOT_B + groupIdFileBytes(GROUP);

let dir: string;
let root: string;
let keptTestsPath: string;
let warned: string[];
let audited: string[];
let live: Lease[];
/** Anything a test made unwritable, so `afterEach` can hand the directory back to `rm`. */
let restore: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rover-'));
	root = join(dir, 'artifacts');
	keptTestsPath = join(dir, 'kept-tests.json');
	warned = [];
	audited = [];
	live = [];
	restore = [];
});

afterEach(async () => {
	// A read-only directory cannot be removed, and the machine would keep it.
	await Promise.all(restore.map((path) => chmod(path, 0o755).catch(() => {})));
	await rm(dir, { recursive: true, force: true });
});

/** One file of a known size, with every directory above it. */
async function file(path: string, sizeBytes: number): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true });
	await writeFile(path, 'x'.repeat(sizeBytes));
}

/** One run's `<serial>`, with the group id a lease named written into it the way the archive does. */
async function grouped(serialDirectory: string, groupId: string): Promise<void> {
	await mkdir(serialDirectory, { recursive: true });
	await writeFile(join(serialDirectory, 'group_id.json'), JSON.stringify({ groupId }));
}

/**
 * The tree every case below deletes from: **one group spanning two tests**, plus the runs that
 * must survive it.
 *
 * | run | test | group | why it is here |
 * | --- | --- | --- | --- |
 * | `RUN_A` | `login-flow` | `GROUP` | goes |
 * | `RUN_B` | `checkout-flow` | `GROUP` | goes — the group spans two tests, R41's own worked shape |
 * | `RUN_C` | `login-flow` | `OTHER_GROUP` | **stays**, so `login-flow` is left standing |
 * | `RUN_D` | `login-flow` | none | **stays** too, and it is the ungrouped half of the same claim |
 * | `RUN_E` | `home-screen` | `GROUP` | under **another project**, so it must not go |
 *
 * `checkout-flow` therefore holds exactly one run of this group and nothing else, which is what
 * makes *a test the deletion empties is removed* and *a test left standing keeps its runs* two
 * assertions on one call rather than two fixtures.
 */
async function seed(): Promise<void> {
	const login = join(root, 'checkout-web', 'login-flow');
	await file(join(login, RUN_A, 'serial-1', 'screenshots', '001_screenshot.png'), SHOT_A);
	await file(join(login, RUN_A, 'serial-1', 'recordings', '001_recording.mp4'), CLIP_A);
	await grouped(join(login, RUN_A, 'serial-1'), GROUP);
	await file(join(login, RUN_C, 'serial-1', 'screenshots', 'shot.png'), SHOT_C);
	await grouped(join(login, RUN_C, 'serial-1'), OTHER_GROUP);
	await file(join(login, RUN_D, 'serial-1', 'screenshots', 'shot.png'), SHOT_D);

	const checkout = join(root, 'checkout-web', 'checkout-flow');
	await file(join(checkout, RUN_B, 'serial-1', 'screenshots', 'shot.png'), SHOT_B);
	await grouped(join(checkout, RUN_B, 'serial-1'), GROUP);

	// The same group id under another project — the pair is the identity, exactly as it is for a
	// kept test (D22, D33).
	const home = join(root, 'rover', 'home-screen');
	await file(join(home, RUN_E, 'serial-2', 'screenshots', 'shot.png'), SHOT_E);
	await grouped(join(home, RUN_E, 'serial-2'), GROUP);
}

/** One kept entry, spelled as the store spells one. */
function kept(project: string, testName: string): KeptTest {
	return { project, testName, keptBy: 'bob', keptAt: '2026-09-01T00:00:00.000Z' };
}

/**
 * The handler under a real sweeper, over the same root and the same kept-tests store the daemon
 * wires them to (`src/daemon/listen.ts`).
 *
 * The retention policy is deliberately enormous: this suite's subject is a **named** delete, and a
 * bound that took a run out from under it would make every byte count here a coincidence (D35, D38).
 */
function handlerFor(maxDirectories?: number): DeleteArchivedGroupHandler {
	const sweeper = createArchiveSweeper({
		root,
		keptTestsPath,
		retention: { budgetMb: 10_000, maxAgeDays: 10_000 },
		liveLeases: () => live,
		log: (line) => audited.push(line),
		warn: (line) => warned.push(line),
	});
	return createDeleteArchivedGroupHandler({
		root,
		keptTestsPath,
		sweeper,
		liveLeases: () => live,
		audit: (line) => audited.push(line),
		warn: (line) => warned.push(line),
		maxDirectories,
	});
}

/** One delete, parsed by **both** wire schemas — see the module header. */
async function deleteGroup(
	params: DeleteArchivedGroupParams,
	maxDirectories?: number,
): Promise<DeleteArchivedGroupResult> {
	const answer = await handlerFor(maxDirectories).delete_archived_group(
		DeleteArchivedGroupParamsSchema.parse(params),
	);
	return DeleteArchivedGroupResultSchema.parse(answer);
}

/** The group under test, deleted by `alice` unless a case says otherwise. */
async function deleteTheGroup(
	overrides: Partial<DeleteArchivedGroupParams> = {},
	maxDirectories?: number,
): Promise<DeleteArchivedGroupResult> {
	return await deleteGroup(
		{ project: 'checkout-web', groupId: GROUP, actor: 'alice', ...overrides },
		maxDirectories,
	);
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * A live lease on one test of `checkout-web`, **and the run directory it is filing into** — seeded
 * at `leaseRunDirectory`'s own path rather than at a name written out here.
 *
 * That is the identity the sweep already compares against and the one the writer files under
 * (D35), and it cannot be spelled by hand: the run directory's name carries a hash of the lease id.
 * So the lease is built first and the tree is seeded from it, which is `archive-sweep.test.ts`'s own
 * arrangement for the same assertion.
 */
async function leaseFilingIntoARunOf(testName: string, groupId: string): Promise<Lease> {
	const lease = createMockLease({ project: 'checkout-web', testName, owner: 'issue-9' });
	const runDirectory = leaseRunDirectory(root, lease);
	await file(join(runDirectory, 'serial-9', 'screenshots', 'shot.png'), 11);
	await grouped(join(runDirectory, 'serial-9'), groupId);
	return lease;
}

/**
 * Whether this process can still write into a directory it just made read-only — it can, when it
 * is root, and then the case being asserted does not exist on this machine.
 */
async function stillWritable(directory: string): Promise<boolean> {
	const probe = join(directory, '.probe');
	try {
		await writeFile(probe, 'x', 'utf8');
		await rm(probe, { force: true });
		return true;
	} catch {
		return false;
	}
}

describe('a group takes its own runs and nothing else', () => {
	beforeEach(seed);

	/*
	 * **The claim the whole method exists for** (D43): the group spans two tests, and what goes is
	 * the runs that named it — not the tests. `RUN_C`, `RUN_D` and `RUN_E` are in this tree
	 * precisely so a delete of *every test the group touches* could not pass this.
	 */
	it('removes the group’s runs across two tests and leaves every other run standing', async () => {
		const result = await deleteTheGroup();

		expect(result).toEqual({
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: RUN_A_BYTES + RUN_B_BYTES,
			keptTestsRemoved: 0,
			runsRemoved: 2,
		});
		const login = join(root, 'checkout-web', 'login-flow');
		expect(await exists(join(login, RUN_A))).toBe(false);
		// The other group's run and the ungrouped one both stay, and so does their test.
		expect(await exists(join(login, RUN_C))).toBe(true);
		expect(await exists(join(login, RUN_D))).toBe(true);
		// And the same group id under another project is not this call's at all.
		expect(await exists(join(root, 'rover', 'home-screen', RUN_E))).toBe(true);
	});

	/*
	 * **A test the deletion empties goes, and a test left standing does not** — the two halves of
	 * D34's *an empty level is scaffolding rather than a record*, on one call.
	 */
	it('removes the test its last run emptied and keeps the one still holding runs', async () => {
		await deleteTheGroup();

		expect(await exists(join(root, 'checkout-web', 'checkout-flow'))).toBe(false);
		expect(await exists(join(root, 'checkout-web', 'login-flow'))).toBe(true);
		// The project still holds a test, so it stays — and the root never goes either way.
		expect(await exists(join(root, 'checkout-web'))).toBe(true);
		expect(await exists(root)).toBe(true);
	});

	/*
	 * **And only then is the kept entry pruned** (D35 as amended, #272's clause one scope over):
	 * `checkout-flow` was emptied, so its exemption goes with it; `login-flow` is still standing,
	 * so its exemption is untouched even though runs of it went.
	 */
	it('prunes the kept entry of the test it emptied and no other', async () => {
		await writeKeptTests(keptTestsPath, [
			kept('checkout-web', 'checkout-flow'),
			kept('checkout-web', 'login-flow'),
			kept('rover', 'home-screen'),
		]);

		expect(await deleteTheGroup()).toMatchObject({
			outcome: 'deleted',
			keptTests: 'removed',
			keptTestsRemoved: 1,
		});

		await expect(readKeptTests(keptTestsPath)).resolves.toEqual([
			kept('checkout-web', 'login-flow'),
			kept('rover', 'home-screen'),
		]);
	});

	/*
	 * **A group that emptied nothing never opens the store**, which is what keeps the arm below it
	 * honest: a call that pruned nothing must not be able to answer `partial` because of a document
	 * it had no business reading. `login-flow` alone holds a run of `OTHER_GROUP` and one of no
	 * group, so deleting `OTHER_GROUP`'s run leaves the test standing.
	 */
	it('leaves the kept-tests store alone when it emptied no test', async () => {
		await writeFile(keptTestsPath, '{ not json', 'utf8');

		expect(await deleteTheGroup({ groupId: OTHER_GROUP })).toEqual({
			outcome: 'deleted',
			archive: 'removed',
			keptTests: 'absent',
			freedBytes: SHOT_C + groupIdFileBytes(OTHER_GROUP),
			keptTestsRemoved: 0,
			runsRemoved: 1,
		});
		// Byte-identical: the store was never read, let alone rewritten.
		expect(await readFile(keptTestsPath, 'utf8')).toBe('{ not json');
	});

	/*
	 * **The project level goes when its last test does**, and the root never does — the sweep's own
	 * rule reached through the one deletion path (D34). `rover` holds exactly one run and it is this
	 * group's.
	 */
	it('removes the project level its last test emptied, and never the archive root', async () => {
		expect(await deleteGroup({ project: 'rover', groupId: GROUP, actor: 'alice' })).toMatchObject({
			outcome: 'deleted',
			runsRemoved: 1,
		});

		expect(await exists(join(root, 'rover'))).toBe(false);
		expect(await exists(root)).toBe(true);
		// And the other project's runs of the same group id are untouched by it.
		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_A))).toBe(true);
	});
});

describe('the four outcomes never collapse into each other', () => {
	beforeEach(seed);

	it('answers not-found for a group no run of this project named', async () => {
		const result = await deleteTheGroup({ groupId: UNUSED_GROUP });

		// Deliberately not a `deleted` that removed nothing: *no run named it* and *its runs went*
		// are two facts, and the schema is what keeps them two (D42's rule two scopes down).
		expect(result).toEqual({ outcome: 'not-found' });
		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_A))).toBe(true);
	});

	/*
	 * A project that never filed anything is the same arm for the same reason — and so is a host
	 * with no archive root at all, which is what the missing scope covers.
	 */
	it('answers not-found for a project this host has nothing under', async () => {
		expect(await deleteGroup({ project: 'never-filed', groupId: GROUP, actor: 'alice' })).toEqual({
			outcome: 'not-found',
		});
	});

	it('answers partial when a run will not go, and still reports the ones that did', async () => {
		// A run is removed by writing to its *parent*, so the test level is what has to refuse.
		const checkout = join(root, 'checkout-web', 'checkout-flow');
		await chmod(checkout, 0o555);
		restore.push(checkout);
		if (await stillWritable(checkout)) {
			// Running as root: there is no unremovable directory on this machine to assert about.
			return;
		}

		const result = await deleteTheGroup();

		expect(result).toMatchObject({
			outcome: 'partial',
			archive: 'failed',
			// The run under the writable test still went, which is what makes `partial` actionable.
			freedBytes: RUN_A_BYTES,
			runsRemoved: 1,
		});
		expect(await exists(join(checkout, RUN_B))).toBe(true);
		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_A))).toBe(false);
	});

	/*
	 * **A walk that was cut short is `partial`, never `deleted`** — the module's sharpest promise.
	 * The bound stops the descent before the second test is examined, so `RUN_B` is never reached;
	 * a `deleted` here would claim the group is gone while one of its runs is still filed.
	 */
	it('answers partial for a truncated walk, with the runs that did go reported', async () => {
		/*
		 * Four directories is the project's own level, `checkout-flow`'s, and `RUN_B`'s — so
		 * `RUN_B` is examined and taken and the descent stops before `login-flow` is opened at all.
		 * The bound is a handler option and never a wire parameter, which is
		 * `list-archive-groups.ts`' own rule (D24).
		 */
		const result = await deleteTheGroup({}, 4);

		expect(result).toMatchObject({ outcome: 'partial', archive: 'failed', runsRemoved: 1 });
		// The run that was never reached is exactly where it was, which is why a `deleted` here
		// would claim a group is gone while part of it is still filed.
		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_A))).toBe(true);
		expect(await exists(join(root, 'checkout-web', 'checkout-flow', RUN_B))).toBe(false);
	});

	/*
	 * And a truncated walk that matched **nothing** is still `partial` rather than `not-found`,
	 * which is where this row parts company with `delete_archived_test`'s ordering: nothing has
	 * established that no run named the group.
	 */
	it('answers partial rather than not-found when it could not examine anything', async () => {
		// One directory is the walk's own starting count, so the project's level is never read.
		const result = await deleteTheGroup({}, 1);

		expect(result).toEqual({
			outcome: 'partial',
			archive: 'failed',
			keptTests: 'absent',
			freedBytes: 0,
			keptTestsRemoved: 0,
			runsRemoved: 0,
		});
	});

	/*
	 * A run that **is** grouped and whose claim the host cannot use truncates the walk for the same
	 * reason: it may equally have been this group's, so passing over it silently would report a
	 * complete removal of a group part of which is still filed.
	 */
	it('answers partial for a group_id.json it cannot make sense of', async () => {
		await writeFile(
			join(root, 'checkout-web', 'login-flow', RUN_D, 'serial-1', 'group_id.json'),
			'{ "groupId": 7 }',
		);

		const result = await deleteTheGroup();

		expect(result).toMatchObject({ outcome: 'partial', archive: 'failed', runsRemoved: 2 });
		// The run whose claim could not be read is left exactly where it was.
		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_D))).toBe(true);
	});
});

describe('a live lease filing into one of the group’s runs is refused, and nothing is touched', () => {
	beforeEach(seed);

	it('refuses while the lease is live and leaves every run and the store alone', async () => {
		await writeKeptTests(keptTestsPath, [kept('checkout-web', 'checkout-flow')]);
		const lease = await leaseFilingIntoARunOf('login-flow', GROUP);
		live = [lease];

		const result = await deleteTheGroup();

		expect(result).toEqual({ outcome: 'refused', reason: 'lease-live' });
		// **Nothing at all**, including the runs under the *other* test, which no lease named: the
		// refusal is checked over every match before the first delete, so it cannot land halfway.
		expect(await exists(leaseRunDirectory(root, lease))).toBe(true);
		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_A))).toBe(true);
		expect(await exists(join(root, 'checkout-web', 'checkout-flow', RUN_B))).toBe(true);
		await expect(readKeptTests(keptTestsPath)).resolves.toHaveLength(1);
	});

	it('does not refuse for a live lease on a run of another group', async () => {
		// The lease's run names `OTHER_GROUP`, so no run this call matched is what it files into.
		const lease = await leaseFilingIntoARunOf('login-flow', OTHER_GROUP);
		live = [lease];

		expect(await deleteTheGroup()).toMatchObject({ outcome: 'deleted', runsRemoved: 2 });
		expect(await exists(leaseRunDirectory(root, lease))).toBe(true);
	});
});

describe('a group id is content and never a path', () => {
	/*
	 * **R41 made executable**: the archive has no `<group_id>/` level, so a group id is matched
	 * against what a run filed. A value with a separator in it, a NUL or a newline is therefore an
	 * ordinary group id rather than an `invalid_params` or an escape — and the only thing that
	 * could have gone wrong is a path being built from it, which the tree afterwards would show.
	 */
	it.each([
		['a separator', '../../etc/passwd'],
		['a NUL', 'group id'],
		['a newline', 'group\nid'],
	])('matches a group id carrying %s as content', async (_case, groupId) => {
		await file(
			join(root, 'checkout-web', 'login-flow', RUN_A, 'serial-1', 'screenshots', 'shot.png'),
			SHOT_A,
		);
		await grouped(join(root, 'checkout-web', 'login-flow', RUN_A, 'serial-1'), groupId);
		await file(
			join(root, 'checkout-web', 'login-flow', RUN_C, 'serial-1', 'screenshots', 'shot.png'),
			SHOT_C,
		);
		await grouped(join(root, 'checkout-web', 'login-flow', RUN_C, 'serial-1'), OTHER_GROUP);

		expect(await deleteTheGroup({ groupId })).toMatchObject({
			outcome: 'deleted',
			runsRemoved: 1,
		});

		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_A))).toBe(false);
		// Nothing outside the run that filed that id was reached, which a path built from it would
		// not have left true.
		expect(await exists(join(root, 'checkout-web', 'login-flow', RUN_C))).toBe(true);
		expect(await exists(join(dir, 'artifacts'))).toBe(true);
	});

	/*
	 * The **project** is a path component and is held to it: a project that resolves out of the root
	 * through a link is `partial` with nothing deleted, which is `archive-sweep.ts`'s strictly-under
	 * rule for a delete rather than the reads' under-or-equal one.
	 */
	it('deletes nothing through a project that resolves out of the archive root', async () => {
		await seed();
		await file(join(dir, 'elsewhere', 'big.bin'), 999);
		await symlink(join(dir, 'elsewhere'), join(root, 'not-ours'));

		const result = await deleteGroup({ project: 'not-ours', groupId: GROUP, actor: 'alice' });

		expect(result).toMatchObject({ outcome: 'partial', archive: 'failed', runsRemoved: 0 });
		expect(await exists(join(dir, 'elsewhere', 'big.bin'))).toBe(true);
		expect(warned.join('\n')).toContain('not strictly inside');
	});

	it('refuses a project component that is not one directory name, before anything is read', () => {
		for (const project of ['..', '.', 'a/b', '']) {
			// The shape is on the wire (`ArchivePathSegmentSchema`), so this never reaches the
			// handler at all — the earliest of the two places containment is enforced.
			expect(
				DeleteArchivedGroupParamsSchema.safeParse({ project, groupId: GROUP, actor: 'alice' })
					.success,
			).toBe(false);
		}
	});
});

describe('what leaves the host, and what stays on it', () => {
	beforeEach(seed);

	it('puts no host path and no errno on any answer', async () => {
		const serialised = JSON.stringify(await deleteTheGroup());

		// The structural promise (D19): there is no field a path would fit in, and the `.strict()`
		// parse above is what makes a smuggled one `invalid_result` on the host.
		expect(serialised).not.toContain(dir);
		expect(serialised).not.toContain(root);
		expect(serialised).not.toContain('ENOENT');
		expect(serialised).not.toContain('message');
	});

	it('says on its own log why a run did not go, naming the path there and only there', async () => {
		const checkout = join(root, 'checkout-web', 'checkout-flow');
		await chmod(checkout, 0o555);
		restore.push(checkout);
		if (await stillWritable(checkout)) {
			return;
		}

		const result = await deleteTheGroup();

		expect(result.outcome).toBe('partial');
		expect(JSON.stringify(result)).not.toContain(root);
		expect(warned.join('\n')).toContain(join(checkout, RUN_B));
	});

	it('writes one audit line naming the actor, both components and the counts', async () => {
		await writeKeptTests(keptTestsPath, [kept('checkout-web', 'checkout-flow')]);

		await deleteTheGroup({ actor: 'jacek' });

		// `Deleted group`, deliberately not `Deleted archived …`: the sweeper's own lines for the
		// runs this took open with the latter, and the daemon's log has to keep the two apart.
		const audit = audited.filter((line) =>
			line.startsWith(`Deleted group "checkout-web"/${JSON.stringify(GROUP)} —`),
		);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('"jacek"');
		expect(audit[0]).toContain('2 runs removed');
		expect(audit[0]).toContain('1 kept test removed');
		// Nothing that is a credential is in scope on this path at all (D20), and no host path is on
		// the record's own line — the warning position is where a path belongs.
		expect(audit[0]).not.toContain('token');
		expect(audit[0]).not.toContain(dir);
	});

	it('says plainly that a delete which reached nothing deleted nothing', async () => {
		await deleteTheGroup({ groupId: UNUSED_GROUP, actor: 'jacek' });

		const audit = audited.filter((line) => line.includes('Nothing was deleted for group'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('"jacek"');
	});

	it('says plainly that a refused delete deleted nothing', async () => {
		live = [await leaseFilingIntoARunOf('login-flow', GROUP)];

		await deleteTheGroup({ actor: 'jacek' });

		const audit = audited.filter((line) => line.includes('Refused to delete group'));
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('nothing was touched');
		expect(audit[0]).toContain('"jacek"');
	});
});

/**
 * `measure_archive_groups` — how much disk the **grouped** runs of one scope take, and the three
 * answers it shares with every other read of this archive (R49, #262).
 *
 * Over a real temp tree built by hand with **known byte counts**, in `archive-size.test.ts`'s idiom
 * and for its reason: what this method answers is bytes somebody can count, and a mocked `fs` would
 * prove only that the module called it. Nothing here goes near `~/.rover` — every root is under one
 * `mkdtemp` directory (`ai/TESTING.md`).
 *
 * The handler is driven directly rather than over a socket, because two of the claims that matter
 * are about the **pair** of outputs: what leaves the host and what stays on it. An injected `warn`
 * is the only way to assert that the path and the `errno` are on the log and *not* on the answer
 * (D19), and the `.strict()` result parse that makes the second half structural is asserted here
 * against the wire schema itself.
 *
 * The claims a reviewer would otherwise take on trust: the `all` scope is the grouped runs **and
 * not the archive**, each narrower scope is its own subset of that, a bounded walk that was cut
 * short says so in all four of the ways it can be cut short, a scope matching nothing is a
 * measured `0` rather than a failure, and **one run measured through `measure_archive` and counted
 * into a group total is the same number** — which is the executable half of *the two measuring
 * methods and the sweep share one `sizeOfTree`*.
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArchiveSizeHandler } from '@/daemon/archive-size.js';
import {
	createMeasureArchiveGroupsHandler,
	type MeasureArchiveGroupsHandler,
} from '@/daemon/measure-archive-groups.js';
import {
	type MeasureArchiveGroupsParams,
	MeasureArchiveGroupsParamsSchema,
	type MeasureArchiveResult,
	MeasureArchiveResultSchema,
} from '@/ipc/methods.js';

/** The runs the seeded tree holds. */
const RUN_A = '20260901T101500Z-issue-1-aaaaaaaa';
const RUN_B = '20260902T101500Z-issue-2-bbbbbbbb';
const RUN_C = '20260903T101500Z-issue-3-cccccccc';
const RUN_D = '20260904T101500Z-issue-4-dddddddd';
const RUN_E = '20260905T101500Z-issue-5-eeeeeeee';

/** The two groups the seeded runs name, and one no run on this host ever named. */
const GROUP = 'app-bar-top-space';
const OTHER_GROUP = 'basket-total';
const UNUSED_GROUP = 'nobody-named-this';

/** Every size below is a distinct number, so no assertion can pass on the wrong sum by luck. */
const SHOT_A = 100;
const CLIP_A = 250;
const SHOT_B = 40;
const SHOT_C = 7;
const SHOT_D = 13;
const SHOT_E = 3_000;
const STRAY = 5;
/** Behind a link out of the root, so a walk that followed one would be caught by the total. */
const OUTSIDE = 999;

/** One `group_id.json`, as a lease writes it — and the bytes it adds to its own run's subtree. */
function groupIdFileBytes(groupId: string): number {
	return JSON.stringify({ groupId }).length;
}

/** `checkout-web`'s two grouped runs, whole run directories — `group_id.json` included. */
const RUN_A_BYTES = SHOT_A + CLIP_A + groupIdFileBytes(GROUP);
const RUN_B_BYTES = SHOT_B + groupIdFileBytes(GROUP);
const RUN_C_BYTES = SHOT_C + groupIdFileBytes(OTHER_GROUP);
/** `rover`'s one grouped run. `RUN_D` names no group at all, and `RUN_E` is `rover`'s ungrouped. */
const RUN_E_BYTES = SHOT_E + groupIdFileBytes(GROUP);

const GROUP_BYTES = RUN_A_BYTES + RUN_B_BYTES + RUN_E_BYTES;
const OTHER_GROUP_BYTES = RUN_C_BYTES;
const CHECKOUT_WEB_GROUPED_BYTES = RUN_A_BYTES + RUN_B_BYTES + RUN_C_BYTES;
const ALL_GROUPED_BYTES = CHECKOUT_WEB_GROUPED_BYTES + RUN_E_BYTES;

let dir: string;
let root: string;
let warned: string[];
/** Anything a test made unreadable, so `afterEach` can hand the directory back to `rm`. */
let restore: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'rover-'));
	root = join(dir, 'artifacts');
	warned = [];
	restore = [];
});

afterEach(async () => {
	// A mode `000` directory cannot be removed, and the machine would keep it.
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
 * The tree every test but the last measures: **two projects, grouped and ungrouped runs**, a file
 * beside a project and a link pointing out of the root.
 *
 * `RUN_D` names no group, so it is the run whose bytes must never reach any of these totals — which
 * is what makes the `all` scope a claim about a *subset* rather than about the archive.
 */
async function seed(): Promise<void> {
	const login = join(root, 'checkout-web', 'login-flow');
	await file(join(login, RUN_A, 'serial-1', 'screenshots', '001_screenshot.png'), SHOT_A);
	await file(join(login, RUN_A, 'serial-1', 'recordings', '001_recording.mp4'), CLIP_A);
	await grouped(join(login, RUN_A, 'serial-1'), GROUP);
	await file(join(login, RUN_B, 'serial-1', 'screenshots', '001_screenshot.png'), SHOT_B);
	await grouped(join(login, RUN_B, 'serial-1'), GROUP);

	const checkout = join(root, 'checkout-web', 'checkout-flow');
	await file(join(checkout, RUN_C, 'serial-1', 'screenshots', 'shot.png'), SHOT_C);
	await grouped(join(checkout, RUN_C, 'serial-1'), OTHER_GROUP);

	// The ungrouped run, in the project the grouped ones are not in.
	const home = join(root, 'rover', 'home-screen');
	await file(join(home, RUN_D, 'serial-1', 'screenshots', 'shot.png'), SHOT_D);
	await file(join(home, RUN_E, 'serial-2', 'screenshots', 'shot.png'), SHOT_E);
	await grouped(join(home, RUN_E, 'serial-2'), GROUP);

	await file(join(root, 'stray.txt'), STRAY);

	/*
	 * Somewhere the archive root does not reach, with more bytes in it than the whole archive —
	 * reachable through two links inside the root. The one at the root is what the `all` scope's
	 * walk passes over and what a `project` scope can name; the one under a project is what a walk
	 * of that project passes over.
	 */
	await file(join(dir, 'elsewhere', 'big.bin'), OUTSIDE);
	await symlink(join(dir, 'elsewhere'), join(root, 'not-ours'));
	await symlink(join(dir, 'elsewhere'), join(root, 'checkout-web', 'not-ours'));
}

function handlerFor(at: string = root, maxDirectories?: number): MeasureArchiveGroupsHandler {
	return createMeasureArchiveGroupsHandler({
		root: at,
		warn: (line) => warned.push(line),
		maxDirectories,
	});
}

/** One measurement, parsed by **both** wire schemas — nothing below asserts on a shape the host could not send or receive. */
async function measure(
	params: MeasureArchiveGroupsParams,
	at: string = root,
	maxDirectories?: number,
): Promise<MeasureArchiveResult> {
	const answer = await handlerFor(at, maxDirectories).measure_archive_groups(
		MeasureArchiveGroupsParamsSchema.parse(params),
	);
	return MeasureArchiveResultSchema.parse(answer);
}

describe('what a grouped scope measures', () => {
	beforeEach(seed);

	/*
	 * **The claim the whole method exists for**: the `all` scope is the grouped runs and not the
	 * archive. `RUN_D` and the stray file beside the project are in this tree precisely so the two
	 * figures cannot coincide.
	 */
	it('answers every grouped run for the `all` scope, and strictly less than the archive', async () => {
		expect(await measure({ scope: 'all' })).toEqual({
			outcome: 'measured',
			bytes: ALL_GROUPED_BYTES,
			truncated: false,
		});

		const whole = MeasureArchiveResultSchema.parse(
			await createArchiveSizeHandler({ root, warn: (line) => warned.push(line) }).measure_archive({
				path: [],
			}),
		);
		if (whole.outcome !== 'measured') {
			throw new Error(`the archive did not measure: ${whole.outcome}`);
		}
		expect(ALL_GROUPED_BYTES).toBeLessThan(whole.bytes);
		expect(whole.bytes - ALL_GROUPED_BYTES).toBe(SHOT_D + STRAY);
	});

	it("answers one project's grouped runs for the `project` scope", async () => {
		expect(await measure({ scope: 'project', project: 'checkout-web' })).toEqual({
			outcome: 'measured',
			bytes: CHECKOUT_WEB_GROUPED_BYTES,
			truncated: false,
		});
		expect(await measure({ scope: 'project', project: 'rover' })).toEqual({
			outcome: 'measured',
			bytes: RUN_E_BYTES,
			truncated: false,
		});
		expect(CHECKOUT_WEB_GROUPED_BYTES).toBeLessThan(ALL_GROUPED_BYTES);
	});

	/*
	 * A group is a `(project, groupId)` pair and never one of them (R41), which this tree makes
	 * assertable: `GROUP` is named by runs in **both** projects, so the group scope's total is
	 * `checkout-web`'s two runs and not `rover`'s third.
	 */
	it("answers one group's runs for the `group` scope, keyed on the project as well", async () => {
		expect(await measure({ scope: 'group', project: 'checkout-web', groupId: GROUP })).toEqual({
			outcome: 'measured',
			bytes: RUN_A_BYTES + RUN_B_BYTES,
			truncated: false,
		});
		expect(await measure({ scope: 'group', project: 'rover', groupId: GROUP })).toEqual({
			outcome: 'measured',
			bytes: RUN_E_BYTES,
			truncated: false,
		});
		expect(
			await measure({ scope: 'group', project: 'checkout-web', groupId: OTHER_GROUP }),
		).toEqual({ outcome: 'measured', bytes: OTHER_GROUP_BYTES, truncated: false });
		// And the two groups of one project come to that project's grouped total, with nothing
		// counted twice and nothing left over.
		expect(RUN_A_BYTES + RUN_B_BYTES + OTHER_GROUP_BYTES).toBe(CHECKOUT_WEB_GROUPED_BYTES);
		expect(GROUP_BYTES + OTHER_GROUP_BYTES).toBe(ALL_GROUPED_BYTES);
	});

	/*
	 * **`0` is a true claim here, and this is the case it must never be confused with
	 * `unreadable`.** Nothing grouped in this scope is a fact about zero bytes; a failed `stat` is
	 * not, which is the pair D6 forbids rendering alike.
	 */
	it('answers zero for a scope that matches no run at all', async () => {
		expect(
			await measure({ scope: 'group', project: 'checkout-web', groupId: UNUSED_GROUP }),
		).toEqual({ outcome: 'measured', bytes: 0, truncated: false });
		expect(warned).toEqual([]);
	});

	it('answers zero for a project whose runs are all ungrouped', async () => {
		const ungrouped = join(dir, 'ungrouped');
		await file(join(ungrouped, 'rover', 'home-screen', RUN_D, 'serial-1', 'shot.png'), SHOT_D);

		expect(await measure({ scope: 'all' }, ungrouped)).toEqual({
			outcome: 'measured',
			bytes: 0,
			truncated: false,
		});
		expect(warned).toEqual([]);
	});

	it('answers missing for a host that has never archived anything', async () => {
		expect(await measure({ scope: 'all' }, join(dir, 'never-used'))).toEqual({
			outcome: 'missing',
		});
		expect(await measure({ scope: 'project', project: 'checkout-web' })).not.toEqual({
			outcome: 'missing',
		});
		expect(warned).toEqual([]);
	});

	// The scope's own root is the project for two of the three scopes, so a project nothing is filed
	// under is `missing` — `measure_archive`'s own answer for that same address.
	it('answers missing for a project nothing is filed under', async () => {
		expect(await measure({ scope: 'project', project: 'no-such-project' })).toEqual({
			outcome: 'missing',
		});
		expect(await measure({ scope: 'group', project: 'no-such-project', groupId: GROUP })).toEqual({
			outcome: 'missing',
		});
		expect(warned).toEqual([]);
	});
});

describe('what it will not measure', () => {
	beforeEach(seed);

	/**
	 * The rule this method inherits whole: a size the host could not take is **never** a `0`. The
	 * scope's own directory is where that is the *answer* rather than a shortfall in it, and
	 * without it a sealed project would read as *nothing grouped in this project*.
	 */
	it('answers unreadable, not zero, for a scope directory it cannot open', async () => {
		const blocked = join(root, 'rover');
		await chmod(blocked, 0o000);
		restore.push(blocked);

		expect(await measure({ scope: 'project', project: 'rover' })).toEqual({
			outcome: 'unreadable',
		});
		expect(await measure({ scope: 'group', project: 'rover', groupId: GROUP })).toEqual({
			outcome: 'unreadable',
		});
	});

	// The other half of D19, and the half a `message` field would quietly undo: the diagnosis
	// exists, and it exists **only** on the host.
	it('keeps the path and the errno on the host and off the answer', async () => {
		const blocked = join(root, 'rover');
		await chmod(blocked, 0o000);
		restore.push(blocked);

		const answer = await measure({ scope: 'project', project: 'rover' });

		expect(JSON.stringify(answer)).not.toContain(dir);
		expect(JSON.stringify(answer)).not.toContain('EACCES');
		expect(warned.join('\n')).toContain(blocked);
		expect(warned.join('\n')).toContain('EACCES');
	});

	// The case `ArchivePathSegmentSchema` cannot see: the one caller-supplied component is no `.`,
	// `..` or separator, and the scope still resolves out of the root.
	it('refuses a project that is a link out of the root', async () => {
		expect(await measure({ scope: 'project', project: 'not-ours' })).toEqual({
			outcome: 'unreadable',
		});
		expect(warned.join('\n')).toContain('outside the archive root');
	});

	// And the same links, unaddressed: `readdir`'s dirent type answers *symlink* with no `stat` at
	// all, so neither the `all` scope's walk nor a project's ever leaves the root.
	it('counts nothing for a link it merely walks past', async () => {
		expect(await measure({ scope: 'all' })).toEqual({
			outcome: 'measured',
			bytes: ALL_GROUPED_BYTES,
			truncated: false,
		});
		expect(await measure({ scope: 'project', project: 'checkout-web' })).toEqual({
			outcome: 'measured',
			bytes: CHECKOUT_WEB_GROUPED_BYTES,
			truncated: false,
		});
		expect(CHECKOUT_WEB_GROUPED_BYTES).toBeLessThan(OUTSIDE);
		expect(warned).toEqual([]);
	});

	// No answer of this method's carries a path or an `errno`, in any of its outcomes — the
	// structural half of D19, asserted over the whole vocabulary rather than over one case.
	it('carries no path and no errno on any answer', async () => {
		const blocked = join(root, 'rover');
		await chmod(blocked, 0o000);
		restore.push(blocked);

		const answers = [
			await measure({ scope: 'all' }),
			await measure({ scope: 'project', project: 'checkout-web' }),
			await measure({ scope: 'project', project: 'rover' }),
			await measure({ scope: 'group', project: 'checkout-web', groupId: GROUP }),
			await measure({ scope: 'all' }, join(dir, 'never-used')),
		];

		for (const answer of answers) {
			const rendered = JSON.stringify(answer);
			expect(rendered).not.toContain(dir);
			expect(rendered).not.toContain('artifacts');
			expect(rendered).not.toMatch(/E[A-Z]{3,}/);
			expect(Object.keys(answer).sort()).not.toContain('message');
		}
	});
});

describe('what a bounded walk says about itself', () => {
	beforeEach(seed);

	/**
	 * A run that **is** grouped and whose claim the host cannot use. Leaving its bytes out silently
	 * would render an incomplete total as a complete one, which is the one thing a subset badge
	 * must not do — so the flag is set even for a `group` scope this run may never have been in.
	 */
	it('says truncated for a `group_id.json` that will not parse', async () => {
		await writeFile(
			join(root, 'checkout-web', 'login-flow', RUN_B, 'serial-1', 'group_id.json'),
			'{ not json at all',
		);

		expect(await measure({ scope: 'all' })).toEqual({
			outcome: 'measured',
			bytes: ALL_GROUPED_BYTES - RUN_B_BYTES,
			truncated: true,
		});
		expect(await measure({ scope: 'group', project: 'checkout-web', groupId: GROUP })).toEqual({
			outcome: 'measured',
			bytes: RUN_A_BYTES,
			truncated: true,
		});
		expect(warned.join('\n')).toContain('is not { "groupId": <string> }');
	});

	// A level the walk could not read mid-way is a short total and has to say so, which is
	// `list_archive_groups`' own rule over a number instead of over a set of rows.
	it('says truncated for a level below the scope it could not read', async () => {
		const blocked = join(root, 'checkout-web', 'checkout-flow');
		await chmod(blocked, 0o000);
		restore.push(blocked);

		expect(await measure({ scope: 'project', project: 'checkout-web' })).toEqual({
			outcome: 'measured',
			bytes: RUN_A_BYTES + RUN_B_BYTES,
			truncated: true,
		});
		expect(warned.join('\n')).toContain('answered as truncated');
	});

	// And a run whose own subtree walk came back short: readable but not traversable lists its
	// children and refuses every `stat` under them, so the run's own bytes are a lower bound.
	it('says truncated for a run whose own subtree walk was short', async () => {
		const blocked = join(root, 'checkout-web', 'login-flow', RUN_A, 'serial-1', 'screenshots');
		await chmod(blocked, 0o400);
		restore.push(blocked);

		expect(await measure({ scope: 'group', project: 'checkout-web', groupId: GROUP })).toEqual({
			outcome: 'measured',
			bytes: RUN_A_BYTES + RUN_B_BYTES - SHOT_A,
			truncated: true,
		});
	});

	/*
	 * The bound that caps disk work when nothing is grouped — `list_archive_groups`' own number and
	 * its own reason. Reaching it is not a refusal: it is a total that says it is a lower bound,
	 * which is the whole reason a *bounded* walk may carry a size badge where it may not carry a
	 * count badge.
	 */
	it('says truncated when the directory bound stops the walk', async () => {
		const answer = await measure({ scope: 'all' }, root, 2);

		if (answer.outcome !== 'measured') {
			throw new Error(`the walk did not measure: ${answer.outcome}`);
		}
		expect(answer.truncated).toBe(true);
		expect(answer.bytes).toBeLessThan(ALL_GROUPED_BYTES);
	});
});

/**
 * The executable half of *the two measuring methods and the sweep share one `sizeOfTree`*.
 *
 * A run's own address is a scope `measure_archive` answers and a run is what a group total is built
 * out of, so the two figures are the same number over the same run — and they are the same number
 * because they are the same walk with the same bound, not because they happen to agree today.
 */
describe('the two measuring methods agree about one run', () => {
	beforeEach(seed);

	it('counts a run into a group total at exactly what `measure_archive` says it takes', async () => {
		const path = ['rover', 'home-screen', RUN_E];
		const own = MeasureArchiveResultSchema.parse(
			await createArchiveSizeHandler({ root, warn: (line) => warned.push(line) }).measure_archive({
				path,
			}),
		);

		// `rover` has exactly one grouped run, so its group total *is* that run's own subtree.
		expect(await measure({ scope: 'group', project: 'rover', groupId: GROUP })).toEqual(own);
		expect(own).toEqual({ outcome: 'measured', bytes: RUN_E_BYTES, truncated: false });
	});
});

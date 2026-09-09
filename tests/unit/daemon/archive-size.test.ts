/**
 * `measure_archive` — how much disk one archive address takes, and the three answers it has
 * (R49, #259).
 *
 * Over a real temp tree built by hand with **known byte counts**, in `archive-sweep.test.ts`'s
 * idiom and for its reason: what this method answers is bytes somebody can count, and a mocked
 * `fs` would prove only that the module called it. Nothing here goes near `~/.rover` — every root
 * is under one `mkdtemp` directory (`ai/TESTING.md`).
 *
 * The handler is driven directly rather than over a socket, because two of the claims that matter
 * are about the **pair** of outputs: what leaves the host and what stays on it. An injected `warn`
 * is the only way to assert that the path and the `errno` are on the log and *not* on the answer
 * (D19); the `.strict()` result parse that makes the second half structural is asserted here
 * against the wire schema itself.
 *
 * The claims a reviewer would otherwise take on trust: a scope answers its own subtree and never
 * the root's, a walk that was cut short says so, `0` is never what something unreadable answers,
 * a link out of the root is refused rather than followed, and **the sweep and this method agree
 * about one run** — which is the executable half of "not two differently-bounded ideas of what the
 * archive weighs".
 */

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArchiveSizeHandler, type MeasureArchiveHandler } from '@/daemon/archive-size.js';
import { createArchiveSweeper } from '@/daemon/archive-sweep.js';
import {
	MAX_ARCHIVE_PATH_DEPTH,
	type MeasureArchiveResult,
	MeasureArchiveResultSchema,
} from '@/ipc/methods.js';

/** The runs the seeded tree holds, and the one file each of them carries. */
const RUN_A = '20260901T101500Z-issue-1-aaaaaaaa';
const RUN_B = '20260902T101500Z-issue-2-bbbbbbbb';
const RUN_C = '20260903T101500Z-issue-3-cccccccc';
const RUN_D = '20260904T101500Z-issue-4-dddddddd';

/** Every size below is a distinct number, so no assertion can pass on the wrong sum by luck. */
const SHOT_A = 100;
const CLIP_A = 250;
const SHOT_B = 40;
const SHOT_C = 7;
const SHOT_D = 13;
const STRAY = 5;
/** Behind a link out of the root, so a walk that followed one would be caught by the total. */
const OUTSIDE = 999;

const LOGIN_FLOW_BYTES = SHOT_A + CLIP_A + SHOT_B;
const CHECKOUT_WEB_BYTES = LOGIN_FLOW_BYTES + SHOT_C;
const ROOT_BYTES = CHECKOUT_WEB_BYTES + SHOT_D + STRAY;

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

/**
 * The tree every test but the last two measures: two projects, four runs, one file beside a
 * project and one link pointing out of the root.
 *
 * The stray file is deliberate — it is what makes the root scope's total *not* the sweep's
 * `totalBytesBefore`, which the module header says out loud rather than papering over.
 */
async function seed(): Promise<void> {
	const login = join(root, 'checkout-web', 'login-flow');
	await file(join(login, RUN_A, 'serial-1', 'screenshots', '001_screenshot.png'), SHOT_A);
	await file(join(login, RUN_A, 'serial-1', 'recordings', '001_recording.mp4'), CLIP_A);
	await file(join(login, RUN_B, 'serial-1', 'screenshots', '001_screenshot.png'), SHOT_B);
	await file(
		join(root, 'checkout-web', 'checkout-flow', RUN_C, 'serial-1', 'screenshots', 'shot.png'),
		SHOT_C,
	);
	await file(
		join(root, 'rover', 'home-screen', RUN_D, 'serial-1', 'screenshots', 'shot.png'),
		SHOT_D,
	);
	await file(join(root, 'stray.txt'), STRAY);

	// Somewhere the archive root does not reach, with more bytes in it than the whole archive.
	await file(join(dir, 'elsewhere', 'big.bin'), OUTSIDE);
	await symlink(join(dir, 'elsewhere'), join(root, 'checkout-web', 'not-ours'));
}

function handlerFor(at: string = root): MeasureArchiveHandler {
	return createArchiveSizeHandler({ root: at, warn: (line) => warned.push(line) });
}

/** One measurement, parsed by the wire schema — so nothing below asserts on a shape the host could not send. */
async function measure(path: string[], at: string = root): Promise<MeasureArchiveResult> {
	const answer = await handlerFor(at).measure_archive({ path });
	return MeasureArchiveResultSchema.parse(answer);
}

describe('what a scope measures', () => {
	beforeEach(seed);

	it('answers the whole archive for the root, and says it was not cut short', async () => {
		expect(await measure([])).toEqual({
			outcome: 'measured',
			bytes: ROOT_BYTES,
			truncated: false,
		});
	});

	// The badge's whole purpose: each context of the `All` view is a different level, and each has
	// to answer *its own* subtree rather than the archive's.
	it('answers each level its own subtree, every one of them short of the root', async () => {
		const scopes = [
			{ path: ['checkout-web'], bytes: CHECKOUT_WEB_BYTES },
			{ path: ['checkout-web', 'login-flow'], bytes: LOGIN_FLOW_BYTES },
			{ path: ['checkout-web', 'login-flow', RUN_A], bytes: SHOT_A + CLIP_A },
			{ path: ['checkout-web', 'login-flow', RUN_A, 'serial-1', 'screenshots'], bytes: SHOT_A },
			{ path: ['rover'], bytes: SHOT_D },
		];

		for (const scope of scopes) {
			expect(await measure(scope.path)).toEqual({
				outcome: 'measured',
				bytes: scope.bytes,
				truncated: false,
			});
			expect(scope.bytes).toBeLessThan(ROOT_BYTES);
		}
	});

	// Without this the address falls into the walk's `ENOTDIR` and answers `0`, which is a claim
	// about an empty directory rather than about a file.
	it('answers a file its own size', async () => {
		const path = [
			'checkout-web',
			'login-flow',
			RUN_A,
			'serial-1',
			'recordings',
			'001_recording.mp4',
		];

		expect(await measure(path)).toEqual({ outcome: 'measured', bytes: CLIP_A, truncated: false });
	});

	// `0` is a true claim exactly here, and this is the case it must never be confused with
	// `unreadable` — the distinction the archive's three outcomes exist to draw.
	it('answers an empty directory zero rather than calling it unreadable', async () => {
		await mkdir(join(root, 'rover', 'nothing-yet'), { recursive: true });

		expect(await measure(['rover', 'nothing-yet'])).toEqual({
			outcome: 'measured',
			bytes: 0,
			truncated: false,
		});
	});

	it('answers missing for an address nothing is filed at', async () => {
		expect(await measure(['checkout-web', 'no-such-test'])).toEqual({ outcome: 'missing' });
		expect(warned).toEqual([]);
	});

	it('answers missing for a host that has never archived anything', async () => {
		expect(await measure([], join(dir, 'never-used'))).toEqual({ outcome: 'missing' });
		expect(warned).toEqual([]);
	});
});

describe('what it will not measure', () => {
	beforeEach(seed);

	/**
	 * The rule the whole method turns on: a size the host could not take is **never** a `0`.
	 * `stat` succeeds on a directory the host may not open — it needs no permission on the
	 * directory itself — so nothing but the handler's own readability probe stands between this
	 * case and an answer that reads as *empty, roughly*.
	 */
	it('answers unreadable, not zero, for a directory it cannot open', async () => {
		const blocked = join(root, 'rover');
		await chmod(blocked, 0o000);
		restore.push(blocked);

		const answer = await measure(['rover']);

		expect(answer).toEqual({ outcome: 'unreadable' });
	});

	// The other half of D19, and the half a `message` field would quietly undo: the diagnosis
	// exists, and it exists **only** on the host.
	it('keeps the path and the errno on the host and off the answer', async () => {
		const blocked = join(root, 'rover');
		await chmod(blocked, 0o000);
		restore.push(blocked);

		const answer = await measure(['rover']);

		expect(JSON.stringify(answer)).not.toContain(dir);
		expect(JSON.stringify(answer)).not.toContain('EACCES');
		expect(warned.join('\n')).toContain(blocked);
		expect(warned.join('\n')).toContain('EACCES');
	});

	// The case `ArchivePathSegmentSchema` cannot see: no component is `.`, `..` or a separator,
	// and the address still resolves out of the root.
	it('refuses a link inside the root that points out of it', async () => {
		expect(await measure(['checkout-web', 'not-ours'])).toEqual({ outcome: 'unreadable' });
		expect(warned.join('\n')).toContain('outside the archive root');
	});

	// And the same link, unaddressed: `readdir`'s dirent type answers *symlink* with no `stat` at
	// all, so a walk over the level holding it never leaves the root either.
	it('counts nothing for a link it merely walks past', async () => {
		expect(await measure(['checkout-web'])).toEqual({
			outcome: 'measured',
			bytes: CHECKOUT_WEB_BYTES,
			truncated: false,
		});
		expect(CHECKOUT_WEB_BYTES).toBeLessThan(OUTSIDE);
	});
});

describe('what a bounded walk says about itself', () => {
	beforeEach(seed);

	/**
	 * A directory readable but not traversable: its listing succeeds and every `stat` under it
	 * fails, which is a **short sum** — so the flag has to be set by an unreadable level and not
	 * only by the depth bound, or a total silently shrinks.
	 */
	it('says truncated when a level below the scope cannot be read', async () => {
		const blocked = join(root, 'checkout-web', 'login-flow', RUN_B, 'serial-1', 'screenshots');
		await chmod(blocked, 0o400);
		restore.push(blocked);

		const answer = await measure(['checkout-web', 'login-flow']);

		expect(answer).toEqual({
			outcome: 'measured',
			bytes: LOGIN_FLOW_BYTES - SHOT_B,
			truncated: true,
		});
	});

	// The bound that exists so a hand-made loop of directories cannot make one walk go forever.
	// Reaching it is not a refusal — it is a number that says it is a lower bound.
	it('says truncated when the depth bound stops the descent', async () => {
		const scope = join(root, 'deep');
		await file(join(scope, 'shallow.txt'), 11);
		const bottom = join(
			scope,
			...Array.from({ length: MAX_ARCHIVE_PATH_DEPTH }, (_, at) => `l${at}`),
		);
		await file(join(bottom, 'bottom.bin'), OUTSIDE);

		expect(await measure(['deep'])).toEqual({ outcome: 'measured', bytes: 11, truncated: true });
	});
});

/**
 * The executable half of the issue's own condition — *the badge and the sweep must not end up
 * with two differently-bounded ideas of what the archive weighs*.
 *
 * A one-run archive is the tree on which the two figures **are** the same number:
 * `totalBytesBefore` totals run subtrees, and there is one. On any other tree they are not, which
 * is why this is asserted here rather than pretended to in general.
 */
describe('the sweep and the measurement agree', () => {
	it('measures a run at exactly what a dry sweep says the archive weighs', async () => {
		const solo = join(dir, 'solo');
		const path = ['rover', 'home-screen', RUN_D];
		await file(join(solo, ...path, 'serial-1', 'screenshots', 'shot.png'), SHOT_D);
		await file(join(solo, ...path, 'serial-1', 'recordings', 'clip.mp4'), CLIP_A);

		const swept = await createArchiveSweeper({
			root: solo,
			keptTestsPath: join(dir, 'kept-tests.json'),
			retention: { budgetMb: 1024, maxAgeDays: 3650 },
			liveLeases: () => [],
			now: () => Date.UTC(2026, 8, 8, 12, 0, 0),
			log: () => {},
			warn: (line) => warned.push(line),
		}).sweep({ dryRun: true, bounds: 'both' });
		const measured = await measure(path, solo);

		if (swept.outcome !== 'swept') {
			throw new Error(`The sweep did not walk the archive: ${swept.outcome}`);
		}
		expect(measured).toEqual({
			outcome: 'measured',
			bytes: swept.totalBytesBefore,
			truncated: false,
		});
		expect(swept.totalBytesBefore).toBe(SHOT_D + CLIP_A);
	});
});

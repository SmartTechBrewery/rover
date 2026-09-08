/**
 * Where the archive puts things — the pure half of R25 (PROJECT.md §10).
 *
 * No disk here at all: the shape of the tree is a stable contract a future read-only viewer
 * reads directly (D24), so it is worth asserting on its own rather than only through a
 * directory listing.
 *
 * Two properties carry the weight, and both are asserted directly rather than inferred from
 * the sanitiser's rules: **containment** — no caller-supplied string can name a path outside
 * the root — and **no collision** — two different hostile strings never share one directory,
 * because the whole point of the archive is comparing two runs and comparing two *callers'*
 * runs would be worse than not comparing at all.
 */

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseLeaseId } from '@/core/ids.js';
import {
	ARTIFACTS_PATH_ENV_VAR,
	leaseArchiveDirectory,
	leaseDirectoryName,
	leaseRunDirectory,
	MAX_SEGMENT_LENGTH,
	pathSegment,
	resolveArtifactsRoot,
	runDirectoryPrecedes,
} from '@/daemon/archive-path.js';
import { createMockLease } from '../../helpers/factories.js';

const DEFAULT_ROOT = join(homedir(), '.rover', 'artifacts');
const ROOT = join('/tmp', 'rover-archive-root');

/** Strings a caller could send that a naive path join would act on. */
const HOSTILE = [
	'../..',
	'..\\..',
	'/etc/passwd',
	'.',
	'..',
	'.hidden',
	'-rf',
	'',
	'nul\0byte',
	'x'.repeat(300),
];

describe('resolveArtifactsRoot', () => {
	it('prefers the configured root', () => {
		expect(resolveArtifactsRoot({ [ARTIFACTS_PATH_ENV_VAR]: '/srv/rover-artifacts' })).toBe(
			'/srv/rover-artifacts',
		);
	});

	it('reads process.env when no environment is passed', () => {
		vi.stubEnv(ARTIFACTS_PATH_ENV_VAR, '/srv/from-process-env');

		expect(resolveArtifactsRoot()).toBe('/srv/from-process-env');
	});

	it('falls back to ~/.rover/artifacts when unset', () => {
		expect(resolveArtifactsRoot({})).toBe(DEFAULT_ROOT);
	});

	it('treats an exported-but-empty value as unset', () => {
		// The same rule the socket and the user store follow: a blank export is what a shell
		// leaves behind, and reading it would file artifacts under the current directory.
		expect(resolveArtifactsRoot({ [ARTIFACTS_PATH_ENV_VAR]: '' })).toBe(DEFAULT_ROOT);
	});
});

describe('pathSegment', () => {
	it('leaves an ordinary string exactly as the caller typed it', () => {
		// The common case has to stay readable — the tree is meant to be browsed by a human.
		for (const plain of ['rover', 'home-screen', 'issue-112', 'emulator_5554', 'v1.2.3']) {
			expect(pathSegment(plain)).toBe(plain);
		}
	});

	it('replaces every separator, so no string can name a second directory', () => {
		expect(pathSegment('a/b')).not.toContain('/');
		expect(pathSegment('a\\b')).not.toContain('\\');
	});

	it('never answers with a component that starts with a dot', () => {
		for (const raw of HOSTILE) {
			expect(pathSegment(raw).startsWith('.')).toBe(false);
		}
	});

	it('never answers with an empty component', () => {
		expect(pathSegment('')).not.toBe('');
		expect(pathSegment('...')).not.toBe('');
	});

	it('bounds the component, suffix included', () => {
		const long = 'x'.repeat(300);

		expect(pathSegment(long).length).toBeLessThanOrEqual(MAX_SEGMENT_LENGTH + 9);
	});

	it('disambiguates two different strings that sanitise to the same text', () => {
		// Without the hash these are one directory, and the before/after diff the archive
		// exists for would be comparing two callers' runs.
		expect(pathSegment('a/b')).not.toBe(pathSegment('a\\b'));
		expect(pathSegment('.')).not.toBe(pathSegment('..'));
	});

	it('is stable — the same string always names the same directory', () => {
		expect(pathSegment('../../etc')).toBe(pathSegment('../../etc'));
	});
});

describe('leaseArchiveDirectory', () => {
	it('is <root>/<project>/<test_name>/<lease>/<serial>', () => {
		const lease = createMockLease({ project: 'rover', testName: 'home-screen' });

		const parts = leaseArchiveDirectory(ROOT, lease)
			.slice(ROOT.length + 1)
			.split(sep);

		expect(parts).toHaveLength(4);
		expect(parts[0]).toBe('rover');
		expect(parts[1]).toBe('home-screen');
		expect(parts[2]).toBe(leaseDirectoryName(lease));
		expect(parts[3]).toBe(lease.serial);
	});

	it('always names the second segment after the test name, sanitised', () => {
		const lease = createMockLease({ project: 'rover', testName: 'home screen' });

		const parts = leaseArchiveDirectory(ROOT, lease)
			.slice(ROOT.length + 1)
			.split(sep);

		expect(parts[1]).toMatch(/^home_screen-[0-9a-f]{8}$/);
	});

	it('stays inside the root for every hostile string a caller could send', () => {
		for (const raw of HOSTILE) {
			const lease = createMockLease({ project: raw, testName: raw, owner: raw });

			expect(resolve(leaseArchiveDirectory(ROOT, lease)).startsWith(resolve(ROOT) + sep)).toBe(
				true,
			);
		}
	});

	it('gives two callers whose strings sanitise alike two different directories', () => {
		const one = createMockLease({ project: 'a/b' });
		const other = createMockLease({ project: 'a\\b' });

		expect(leaseArchiveDirectory(ROOT, one)).not.toBe(leaseArchiveDirectory(ROOT, other));
	});
});

describe('leaseDirectoryName', () => {
	it('is <timestamp>-<owner>-<hash>', () => {
		const lease = createMockLease({
			owner: 'issue-112',
			createdAtMs: Date.UTC(2026, 7, 30, 17, 5, 1, 123),
		});

		expect(leaseDirectoryName(lease)).toMatch(/^20260830T170501Z-issue-112-[0-9a-f]{8}$/);
	});

	it('sorts chronologically as text, which is what makes the diff an `ls`', () => {
		const earlier = createMockLease({ createdAtMs: Date.UTC(2026, 7, 30, 17, 5, 1) });
		const later = createMockLease({ createdAtMs: Date.UTC(2026, 7, 30, 17, 5, 2) });

		expect([leaseDirectoryName(later), leaseDirectoryName(earlier)].sort()).toEqual([
			leaseDirectoryName(earlier),
			leaseDirectoryName(later),
		]);
	});

	it('never contains the lease id — the credential does not become a path', () => {
		const lease = createMockLease();

		// The id is what ends a lease (D20). A tree meant to be browsed, and later served by a
		// read-only panel, must not publish one.
		expect(leaseDirectoryName(lease)).not.toContain(lease.id);
	});

	it('separates two leases granted in the same second', () => {
		const createdAtMs = Date.UTC(2026, 7, 30, 17, 5, 1);
		const one = createMockLease({ id: parseLeaseId('lease-one'), createdAtMs });
		const other = createMockLease({ id: parseLeaseId('lease-two'), createdAtMs });

		expect(leaseDirectoryName(one)).not.toBe(leaseDirectoryName(other));
	});

	it('does not stop being a single component for a hostile owner', () => {
		const lease = createMockLease({ owner: '../../etc' });

		expect(leaseDirectoryName(lease)).not.toContain(sep);
	});
});

/**
 * The run directory the sweep deletes (#238) — the three levels above the serial.
 *
 * The claim worth asserting is that it is the **same** account of the layout as the writer's,
 * because that is what makes the sweep's live-lease exemption exact rather than approximately
 * right: a sweeper matching a run by path asks this function, and the writer files under
 * `leaseArchiveDirectory`.
 */
describe('leaseRunDirectory', () => {
	it('is <root>/<project>/<test_name>/<lease>, and nothing below it', () => {
		const lease = createMockLease({ project: 'rover', testName: 'home-screen' });

		const parts = leaseRunDirectory(ROOT, lease)
			.slice(ROOT.length + 1)
			.split(sep);

		expect(parts).toHaveLength(3);
		expect(parts[0]).toBe('rover');
		expect(parts[1]).toBe('home-screen');
		expect(parts[2]).toBe(leaseDirectoryName(lease));
	});

	it('is exactly what the writer files under, less the serial', () => {
		const lease = createMockLease({ project: 'rover', testName: 'home screen' });

		expect(leaseArchiveDirectory(ROOT, lease)).toBe(
			join(leaseRunDirectory(ROOT, lease), pathSegment(lease.serial)),
		);
	});

	it('stays inside the root for every hostile string a caller could send', () => {
		for (const raw of HOSTILE) {
			const lease = createMockLease({ project: raw, testName: raw, owner: raw });

			expect(resolve(leaseRunDirectory(ROOT, lease)).startsWith(resolve(ROOT) + sep)).toBe(true);
		}
	});
});

/**
 * The whole of the age rule (#238): one `<` on two strings, with **no `Date` constructed from a
 * directory name and no `localeCompare`.**
 *
 * The cutoff is formatted by the same function that formatted the name, and that format is
 * fixed-width UTC basic — which is what makes code-unit order chronological order.
 */
describe('runDirectoryPrecedes', () => {
	const instantMs = Date.UTC(2026, 8, 8, 12, 0, 0);
	const nameAt = (ms: number): string => leaseDirectoryName(createMockLease({ createdAtMs: ms }));

	it('answers true for a run granted before the instant', () => {
		expect(runDirectoryPrecedes(nameAt(instantMs - 1_000), instantMs)).toBe(true);
	});

	it('answers false for a run granted after it', () => {
		expect(runDirectoryPrecedes(nameAt(instantMs + 1_000), instantMs)).toBe(false);
	});

	/*
	 * A run granted *in* the cutoff second is not before it: the name carries the timestamp plus
	 * `-<owner>-<hash>`, so it sorts after the bare timestamp. The direction that matters is that
	 * it is never *taken* on the strength of a second's rounding.
	 */
	it('answers false for a run granted inside the cutoff second', () => {
		expect(runDirectoryPrecedes(nameAt(instantMs), instantMs)).toBe(false);
	});

	/*
	 * **A name that does not lead with a timestamp is still never parsed**, and text order puts a
	 * name leading with a letter or `_` after every real timestamp — so it is never selected by
	 * age. The other direction, a name leading with `.` or `-`, is recorded in the module header
	 * as the cost of never parsing; nothing Rover files can lead with either.
	 */
	it('never selects a hand-made directory whose name leads with a letter', () => {
		expect(runDirectoryPrecedes('unlabeled', instantMs)).toBe(false);
		expect(runDirectoryPrecedes('_scratch', instantMs)).toBe(false);
	});

	it('is monotonic in the instant, which is what makes it an age rule', () => {
		const name = nameAt(instantMs);

		expect(runDirectoryPrecedes(name, instantMs - 1_000)).toBe(false);
		expect(runDirectoryPrecedes(name, instantMs + 1_000)).toBe(true);
	});
});

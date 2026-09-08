/**
 * `list_archive_groups` end to end: a real daemon on a temp socket, an artifact root a real
 * `ArtifactArchive` wrote, and a client asking over the real framing.
 *
 * The daemon suite's real-socket exception applies (ai/TESTING.md) — never `~/.rover/rover.sock`,
 * and every daemon closed through its own handle in `afterEach`. The filesystem is real for
 * `search-archive.test.ts`'s reason: what this method answers is files somebody can list, and a
 * mocked `fs` would prove only that the module called it. Every root is a `mkdtemp` — **no test
 * writes into `~/.rover/artifacts`**.
 *
 * Real rather than a direct call on the handler, because the `.strict()` result parse in
 * `src/ipc/server.ts` is half of what is asserted here: it is what makes "no host path can be on
 * an answer" structural (D19), and it is what makes every structural cap a bound on the *wire*
 * rather than a habit of one module.
 *
 * The populated tree is written by **`createArtifactArchive` itself** wherever the run levels
 * matter, so the reader is asserted against what the writer actually writes; only the shapes the
 * writer cannot produce — an unreadable directory, a `group_id.json` that will not parse, a run
 * holding two entries — are made by hand.
 */

import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLeaseId } from '@/core/ids.js';
import { type ArchivableResult, createArtifactArchive } from '@/daemon/archive.js';
import { leaseDirectoryName, pathSegment } from '@/daemon/archive-path.js';
import type { Lease } from '@/daemon/leases.js';
import { createListArchiveGroupsHandler } from '@/daemon/list-archive-groups.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import type { IpcClient } from '@/ipc/client.js';
import { MAX_FRAME_BYTES } from '@/ipc/framing.js';
import {
	type ArchiveGroup,
	ListArchiveGroupsParamsSchema,
	type ListArchiveGroupsResult,
	ListArchiveGroupsResultSchema,
	ListArchiveParamsSchema,
	MAX_ARCHIVE_GROUP_ARTIFACTS,
} from '@/ipc/methods.js';
import { IpcRequestError } from '@/ipc/protocol.js';
import {
	connectWithoutStarting,
	createTempSocket,
	isSweepLogLine,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import {
	createMockDeviceInfo,
	createMockLease,
	createMockLogRead,
} from '../../helpers/factories.js';

let temp: TempSocket;
const running: RunningDaemon[] = [];
const clients: IpcClient[] = [];
/** Everything the handler said on the host. Spied rather than injected: the daemon builds it. */
let warnings: string[];

const CAPTURE = {
	mediaType: 'image/png',
	base64: Buffer.from(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x01])).toString('base64'),
	byteLength: 5,
};
const RECORDING = {
	mediaType: 'video/mp4',
	base64: Buffer.from(Uint8Array.from([0x00, 0x00, 0x00, 0x18])).toString('base64'),
	byteLength: 4,
};

beforeEach(async () => {
	temp = await createTempSocket();
	warnings = [];
	// The daemon runs a full pass of its retention policy as it comes up (D38) and writes to this
	// same log, at a moment nothing here sequences — dropped at the spy so what is counted below
	// is this suite's own subject (`isSweepLogLine`).
	vi.spyOn(console, 'warn').mockImplementation((line: string) => {
		if (!isSweepLogLine(line)) {
			warnings.push(line);
		}
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	if (temp) {
		// Anything a test made unreadable has to be readable again, or the temp directory
		// cannot be removed and the machine keeps it.
		await chmod(temp.artifactsRoot, 0o755).catch(() => {});
		await removeTempSocket(temp);
	}
});

/** The one daemon a test needs, started on the first ask so a test may look more than once. */
async function start(): Promise<void> {
	if (running.length > 0) {
		return;
	}
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: temp.retention,
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
}

async function connect(): Promise<IpcClient> {
	const existing = clients[0];
	if (existing) {
		return existing;
	}
	const client = await connectWithoutStarting(temp.socketPath);
	if (!client) {
		throw new Error('Nothing is serving the temp socket');
	}
	clients.push(client);
	return client;
}

/** One request, against a daemon this helper starts. */
async function list(): Promise<ListArchiveGroupsResult> {
	await start();
	return (await connect()).request('list_archive_groups', {});
}

/**
 * The handler on its own, with one or more of its bounds lowered — the only way to reach a cap
 * without writing the archive that would reach it, and the reason those bounds are handler options
 * rather than wire parameters (D24).
 */
function handlerWith(bounds: {
	readonly maxGroups?: number;
	readonly maxRuns?: number;
	readonly maxEntries?: number;
}) {
	return createListArchiveGroupsHandler({
		root: temp.artifactsRoot,
		warn: (line) => warnings.push(line),
		...bounds,
	});
}

/** Everything the answer counts against the whole-answer bound: every run and every artifact. */
function entriesOf(result: ListArchiveGroupsResult): number {
	return groupsOf(result).reduce(
		(total, group) =>
			total + group.runs.length + group.runs.reduce((sum, run) => sum + run.artifacts.length, 0),
		0,
	);
}

/** The groups, or a failed test naming the outcome that was answered instead. */
function groupsOf(result: ListArchiveGroupsResult): readonly ArchiveGroup[] {
	if (result.outcome !== 'listed') {
		throw new Error(`The archive was not walked: ${result.outcome}`);
	}
	return result.groups;
}

let nextLease = 0;

/** A lease of its own — a distinct id, so its run directory is its own (`leaseDirectoryName`). */
function leaseFor(overrides: Partial<Lease> = {}): Lease {
	nextLease += 1;
	return createMockLease({
		id: parseLeaseId(`lease-${nextLease}`),
		project: 'rover',
		testName: 'home-screen',
		...overrides,
	});
}

function resultOf(verb: string, of: Lease, overrides: Partial<ArchivableResult> = {}) {
	return {
		verb,
		device: createMockDeviceInfo({ serial: of.serial }),
		target: null,
		after: { kind: 'screen' as const, elements: [] },
		artifact: null,
		...overrides,
	} as ArchivableResult;
}

/** The production writer, so what the reader is asserted against is what the writer writes. */
function archive() {
	return createArtifactArchive({ root: temp.artifactsRoot, warn: () => {} });
}

/** One archived screenshot under `of`, with an optional label. */
async function archiveAScreenshot(of: Lease, label?: string): Promise<void> {
	await archive().record(of, resultOf('screenshot', of, { artifact: CAPTURE }), label);
}

/** One archived recording and its one frame — the pair whose two names must agree on a label. */
async function archiveARecording(of: Lease, label?: string): Promise<void> {
	await archive().record(
		of,
		resultOf('record_video', of, { artifact: RECORDING, frames: [{ ...CAPTURE }] }),
		label,
	);
}

/** The four components of one lease's own run, as the writer names them. */
function runPathOf(of: Lease): string[] {
	return [
		pathSegment(of.project),
		pathSegment(of.testName),
		leaseDirectoryName(of),
		pathSegment(of.serial),
	];
}

/**
 * Whether this process can still read a directory it just made unreadable — it can, when it is
 * root, and then the case being asserted does not exist on this machine.
 */
async function stillReadable(directory: string): Promise<boolean> {
	try {
		await readdir(directory);
		return true;
	} catch {
		return false;
	}
}

describe('the three answers, which must never be one', () => {
	it('says missing for a root nothing has ever archived into', async () => {
		// Nothing pre-creates `temp.artifactsRoot`, so this is a host on its first day.
		expect(await list()).toEqual({ outcome: 'missing' });
	});

	it('says unreadable when the root is not a directory at all', async () => {
		await writeFile(temp.artifactsRoot, 'not a directory');

		expect(await list()).toEqual({ outcome: 'unreadable' });
	});

	it('says unreadable, not empty, for a root this host has no permission to read', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		await mkdir(join(temp.artifactsRoot, 'a-project'));
		await chmod(temp.artifactsRoot, 0o000);
		if (await stillReadable(temp.artifactsRoot)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		expect(await list()).toEqual({ outcome: 'unreadable' });
	});

	it('says listed with no groups — nothing is grouped, which is not a failure', async () => {
		await archiveAScreenshot(leaseFor());

		// The load-bearing distinction (D6): an archive nobody grouped anything in must not read
		// like an archive that is not there, or like one the host cannot see into.
		expect(await list()).toEqual({ outcome: 'listed', groups: [], truncated: false });
	});

	it('names the root and the reason on the host, and never on the wire', async () => {
		await writeFile(temp.artifactsRoot, 'not a directory');

		expect(await list()).toEqual({ outcome: 'unreadable' });
		// The diagnosis the answer may not carry lives here instead (D19).
		expect(warnings.join('\n')).toContain(temp.artifactsRoot);
		expect(warnings.join('\n')).toContain('ENOTDIR');
		// And it says what the caller was actually told. This arm has no `truncated` field at all,
		// so a line claiming the walk answered as truncated would misdescribe the answer in the
		// host's only account of it.
		expect(warnings.join('\n')).toContain('answered as unreadable');
		expect(warnings.join('\n')).not.toContain('answered as truncated');
	});
});

describe('which groups exist, and which runs are in each', () => {
	it('answers one group per (project, group id) pair, with the runs that named it', async () => {
		const before = leaseFor({ groupId: 'app-bar', testName: 'home_before' });
		const after = leaseFor({ groupId: 'app-bar', testName: 'home_after' });
		const other = leaseFor({ groupId: 'checkout-total', testName: 'basket' });
		for (const of of [before, after, other]) {
			await archiveAScreenshot(of);
		}

		const groups = groupsOf(await list());
		expect(groups.map((group) => [group.project, group.groupId])).toEqual([
			['rover', 'app-bar'],
			['rover', 'checkout-total'],
		]);
		expect(groups[0]?.runs.map((run) => run.path)).toEqual([runPathOf(after), runPathOf(before)]);
		expect(groups[1]?.runs.map((run) => run.path)).toEqual([runPathOf(other)]);
	});

	it('answers a run path a list_archive walk would have reached, component for component', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of, 'home-screen');

		const [group] = groupsOf(await list());
		const run = group?.runs[0];
		if (!run) {
			throw new Error('the grouped run was not found');
		}
		// One path vocabulary for the archive (R37), asserted through the schema rather than by
		// eye — and then actually followed, which is what makes it more than a shape claim.
		expect(ListArchiveParamsSchema.safeParse({ path: run.path }).success).toBe(true);
		const level = await (await connect()).request('list_archive', { path: [...run.path] });
		expect(level.outcome === 'listed' && level.entries.map((entry) => entry.name)).toContain(
			'group_id.json',
		);
	});

	it('keeps two projects reusing one group id apart', async () => {
		const here = leaseFor({ project: 'rover', groupId: 'shared' });
		const there = leaseFor({ project: 'another-app', groupId: 'shared' });
		await archiveAScreenshot(here);
		await archiveAScreenshot(there);

		// Nothing makes a group id unique (`GroupIdSchema`), and `project` is the archive's own
		// top-level partition precisely so two of them never collide (§10).
		expect(groupsOf(await list()).map((group) => [group.project, group.groupId])).toEqual([
			['another-app', 'shared'],
			['rover', 'shared'],
		]);
	});

	it('leaves a run that named no group out of the answer entirely', async () => {
		const ungrouped = leaseFor();
		const inAGroup = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(ungrouped);
		await archiveAScreenshot(inAGroup);

		const result = await list();
		expect(groupsOf(result).flatMap((group) => group.runs.map((run) => run.path))).toEqual([
			runPathOf(inAGroup),
		]);
		// An ungrouped run is ordinary, not a shortfall: nothing about it truncates the answer.
		expect(result.outcome === 'listed' && result.truncated).toBe(false);
	});

	it('answers the group id verbatim, parsing nothing out of it', async () => {
		const opaque = 'PR #178 / before ↔ after';
		await archiveAScreenshot(leaseFor({ groupId: opaque }));

		// It is opaque attribution (D22) and it never became a path component, so nothing
		// sanitised it and nothing may.
		expect(groupsOf(await list())[0]?.groupId).toBe(opaque);
	});
});

describe('which of a grouped run’s artifacts carry a label', () => {
	it('answers every filed label, each at its own address', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		const durable = archive();
		await durable.record(of, resultOf('screenshot', of, { artifact: CAPTURE }), 'before');
		await durable.record(of, resultOf('screenshot', of, { artifact: CAPTURE }), 'after');
		await durable.record(
			of,
			resultOf('record_video', of, {
				artifact: RECORDING,
				frames: [{ ...CAPTURE }],
			}),
			'the-whole-flow',
		);
		await durable.record(of, resultOf('read_logs', of, { logs: createMockLogRead() }), 'the-crash');

		const run = groupsOf(await list())[0]?.runs[0];
		const path = runPathOf(of);
		expect(run?.artifacts).toEqual([
			{ path: [...path, 'logs', '001_the-crash_read_logs.txt'], label: 'the-crash' },
			{ path: [...path, 'recordings', '001_the-whole-flow.mp4'], label: 'the-whole-flow' },
			// The frame directory beside the recording carries the same label and is answered as
			// its own artifact; nothing descends into it, because a frame has no label of its own.
			{ path: [...path, 'recordings', '001_the-whole-flow_frames'], label: 'the-whole-flow' },
			{ path: [...path, 'screenshots', '001_before_screenshot.png'], label: 'before' },
			{ path: [...path, 'screenshots', '002_after_screenshot.png'], label: 'after' },
		]);
	});

	it('answers a group whose runs labelled nothing with empty artifact lists', async () => {
		const before = leaseFor({ groupId: 'app-bar', testName: 'home_before' });
		const after = leaseFor({ groupId: 'app-bar', testName: 'home_after' });
		await archiveAScreenshot(before);
		await archiveAScreenshot(after);

		// A group is a claim about *runs*; labelling artifacts inside one is a second, independent
		// choice, so this is ordinary and not a failure.
		expect(groupsOf(await list())[0]?.runs.map((run) => run.artifacts)).toEqual([[], []]);
	});

	it('leaves an unlabelled artifact out of a grouped run, and truncates nothing', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		const durable = archive();
		await durable.record(of, resultOf('screenshot', of, { artifact: CAPTURE }));
		await durable.record(of, resultOf('screenshot', of, { artifact: CAPTURE }), 'after');

		const result = await list();
		// Absent rather than present with a `null` label: nothing is invented for a call that
		// named nothing (#129's lesson), and the two screenshots are both on disk.
		expect(groupsOf(result)[0]?.runs[0]?.artifacts).toEqual([
			{
				path: [...runPathOf(of), 'screenshots', '002_after_screenshot.png'],
				label: 'after',
			},
		]);
		expect(result.outcome === 'listed' && result.truncated).toBe(false);
		expect(await readdir(join(temp.artifactsRoot, ...runPathOf(of), 'screenshots'))).toHaveLength(
			2,
		);
	});

	/*
	 * The one class of label a name cannot carry back, because a recording is the single artifact
	 * the writer files with no fixed suffix after the label (`archive-path.ts`, PROJECT.md §10).
	 * What is asserted is not that the label survives — it cannot — but that **the recording and
	 * its frame directory never answer two different things**, which is what a reader grouping by
	 * label depends on.
	 */
	it('drops a recording labelled exactly like a verb suffix, and its frames with it', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveARecording(of, 'screenshot');

		// Both names are on disk, and neither is answered: `001_screenshot.mp4` is spelled the way
		// an *unlabelled* screenshot is, so answering `screenshot` here would give every unlabelled
		// screenshot on every host a label nobody gave it. Absent is the honest half of that pair.
		expect(await readdir(join(temp.artifactsRoot, ...runPathOf(of), 'recordings'))).toEqual([
			'001_screenshot.mp4',
			'001_screenshot_frames',
		]);
		expect(groupsOf(await list())[0]?.runs[0]?.artifacts).toEqual([]);
	});

	it('answers a recording whose label ends in a verb suffix under one label, on both halves', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveARecording(of, 'home_screenshot');

		// The head is what a name ending in a suffix token can carry back, and the frame directory
		// is decoded by the recording's own rule so that it cannot answer `home_screenshot` while
		// the recording beside it answers `home` — one artifact pair, one label.
		expect(groupsOf(await list())[0]?.runs[0]?.artifacts).toEqual([
			{ path: [...runPathOf(of), 'recordings', '001_home_screenshot.mp4'], label: 'home' },
			{ path: [...runPathOf(of), 'recordings', '001_home_screenshot_frames'], label: 'home' },
		]);
	});

	it('answers the label the archive filed, which is not the caller’s own string', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of, 'before change!');

		// `pathSegment` ran on the way in and is not reversible, so this is what the archive
		// called it — the rule `docs/DESIGN.md` §9 already states for `OWNER`.
		const label = groupsOf(await list())[0]?.runs[0]?.artifacts[0]?.label;
		expect(label).toBe(pathSegment('before change!'));
		expect(label).not.toBe('before change!');
	});

	it('never mistakes one of the lease’s own three files for a labelled artifact', async () => {
		const of = leaseFor({ groupId: 'app-bar', testDescription: 'What this run checks.' });
		await archiveAScreenshot(of);

		// `device_info.json`, `test_description.json` and `group_id.json` all sit in the
		// `<serial>` directory this walk reads, and none of them is an artifact.
		expect(await readdir(join(temp.artifactsRoot, ...runPathOf(of)))).toEqual(
			expect.arrayContaining(['device_info.json', 'group_id.json', 'test_description.json']),
		);
		expect(groupsOf(await list())[0]?.runs[0]?.artifacts).toEqual([]);
	});
});

describe('the bounds, and the one thing truncated means', () => {
	it('stops after the directory bound and says the answer is truncated', async () => {
		// The bound is a handler option with a default — never a wire parameter, which is D24's
		// refusal — so it is asserted by calling the handler directly rather than by making five
		// thousand directories.
		for (let index = 0; index < 6; index += 1) {
			await archiveAScreenshot(
				leaseFor({ groupId: 'app-bar', testName: `t${String(index).padStart(2, '0')}` }),
				'before',
			);
		}
		const handler = createListArchiveGroupsHandler({
			root: temp.artifactsRoot,
			warn: (line) => warnings.push(line),
			maxDirectories: 4,
		});

		const result = await handler.list_archive_groups({});
		expect(result.outcome === 'listed' && result.truncated).toBe(true);
		// The bound stopped the descent, so most of the runs are missing — which is exactly what
		// `truncated` says. What it did *not* do is throw away what it had already read.
		expect(groupsOf(result).flatMap((group) => group.runs).length).toBeLessThan(6);
	});

	it('is not truncated when the whole archive fitted inside every bound', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of, 'before');

		expect(await list()).toEqual({
			outcome: 'listed',
			groups: [
				{
					project: 'rover',
					groupId: 'app-bar',
					runs: [
						{
							path: runPathOf(of),
							artifacts: [
								{
									path: [...runPathOf(of), 'screenshots', '001_before_screenshot.png'],
									label: 'before',
								},
							],
						},
					],
				},
			],
			truncated: false,
		});
	});

	it('caps the groups of one answer and says it is truncated', async () => {
		// The caps are handler options with defaults, exactly as the directory bound is, so the
		// cap itself is what is asserted rather than two hundred groups' worth of writing.
		await archiveAScreenshot(leaseFor({ groupId: 'app-bar', testName: 'a' }));
		await archiveAScreenshot(leaseFor({ groupId: 'checkout-total', testName: 'b' }));

		const result = await handlerWith({ maxGroups: 1 }).list_archive_groups({});
		expect(groupsOf(result).map((group) => group.groupId)).toEqual(['app-bar']);
		expect(result.outcome === 'listed' && result.truncated).toBe(true);
		// The cap dropped a group rather than producing one the schema would refuse — which is
		// the whole point of enforcing it here, and is what `invalid_result` would be instead.
		expect(ListArchiveGroupsResultSchema.safeParse(result).success).toBe(true);
	});

	it('caps the runs of one group and says the answer is truncated', async () => {
		const first = leaseFor({ groupId: 'app-bar', testName: 'a' });
		await archiveAScreenshot(first);
		await archiveAScreenshot(leaseFor({ groupId: 'app-bar', testName: 'b' }));

		const result = await handlerWith({ maxRuns: 1 }).list_archive_groups({});
		expect(groupsOf(result)[0]?.runs.map((run) => run.path)).toEqual([runPathOf(first)]);
		expect(result.outcome === 'listed' && result.truncated).toBe(true);
		// And the group the cap left behind still has a run in it — `ArchiveGroupSchema.runs` is
		// `.min(1)`, so a group emptied by a cap would be an `invalid_result` on the host.
		expect(ListArchiveGroupsResultSchema.safeParse(result).success).toBe(true);
	});

	it('caps the whole answer across runs and artifacts, and says it is truncated', async () => {
		// The three structural caps bound one level each and nothing bounds their product, so this
		// is the bound that keeps a large grouped archive from answering a frame no caller can
		// decode. Two runs of two labelled screenshots is six entries; three is where it stops.
		for (const testName of ['a', 'b']) {
			const of = leaseFor({ groupId: 'app-bar', testName });
			await archiveAScreenshot(of, 'before');
			await archiveAScreenshot(of, 'after');
		}

		const result = await handlerWith({ maxEntries: 3 }).list_archive_groups({});
		expect(entriesOf(result)).toBe(3);
		expect(result.outcome === 'listed' && result.truncated).toBe(true);
		// The property the cap exists for: what came back is something the framing can carry.
		expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(MAX_FRAME_BYTES);
		expect(ListArchiveGroupsResultSchema.safeParse(result).success).toBe(true);
	});

	it('caps the artifacts of one run and says the answer is truncated', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		const directory = join(temp.artifactsRoot, ...runPathOf(of), 'screenshots');
		await archiveAScreenshot(of, 'before');
		// Made by hand: the writer would need one verb call per file, and the cap is what is
		// being asserted rather than the writer.
		for (let index = 0; index < MAX_ARCHIVE_GROUP_ARTIFACTS + 5; index += 1) {
			await writeFile(
				join(directory, `${String(index).padStart(4, '0')}_before_screenshot.png`),
				'',
			);
		}

		const result = await list();
		expect(groupsOf(result)[0]?.runs[0]?.artifacts).toHaveLength(MAX_ARCHIVE_GROUP_ARTIFACTS);
		expect(result.outcome === 'listed' && result.truncated).toBe(true);
	});
});

describe('a run this walk cannot make sense of', () => {
	it('drops a run whose group_id.json will not parse, warns, and truncates', async () => {
		const broken = leaseFor({ groupId: 'app-bar', testName: 'home_broken' });
		const sound = leaseFor({ groupId: 'app-bar', testName: 'home_sound' });
		await archiveAScreenshot(broken);
		await archiveAScreenshot(sound);
		const path = join(temp.artifactsRoot, ...runPathOf(broken), 'group_id.json');
		await writeFile(path, 'not json at all');

		const result = await list();
		// A run that *is* grouped is missing, so an incomplete group must not render as a
		// complete one — which is the one thing `truncated` says.
		expect(groupsOf(result)[0]?.runs.map((run) => run.path)).toEqual([runPathOf(sound)]);
		expect(result.outcome === 'listed' && result.truncated).toBe(true);
		expect(warnings.join('\n')).toContain(path);
		// And nothing of the file's own contents left the host, in either direction.
		expect(warnings.join('\n')).not.toContain('not json at all');
		expect(JSON.stringify(result)).not.toContain('home_broken');
	});

	it('drops a run whose group_id.json is JSON of the wrong shape, on the same terms', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of);
		await writeFile(
			join(temp.artifactsRoot, ...runPathOf(of), 'group_id.json'),
			JSON.stringify({ group: 'app-bar' }),
		);

		expect(await list()).toEqual({ outcome: 'listed', groups: [], truncated: true });
	});

	it('skips a run directory holding two serial directories, and truncates nothing', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of);
		// One lease is one device (D7), so a second *directory* at the run level is a fact about
		// that run rather than a shortfall in the answer — the same rule `onlyChild` applies.
		const run = join(temp.artifactsRoot, ...runPathOf(of).slice(0, 3));
		await mkdir(join(run, 'a-second-serial'));

		expect(await list()).toEqual({ outcome: 'listed', groups: [], truncated: false });
		expect(warnings).toEqual([]);
	});

	it('still answers a run whose directory also holds a stray file', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of, 'before');
		// This tree is meant to be opened by a human (D24) and a file browser writes into what it
		// opens. A `.DS_Store` beside the `<serial>` may not delete the run from every answer —
		// silently, since a run skipped for its shape sets no `truncated` either.
		await writeFile(join(temp.artifactsRoot, ...runPathOf(of).slice(0, 3), '.DS_Store'), '');

		const result = await list();
		expect(groupsOf(result)[0]?.runs).toEqual([
			{
				path: runPathOf(of),
				artifacts: [
					{ path: [...runPathOf(of), 'screenshots', '001_before_screenshot.png'], label: 'before' },
				],
			},
		]);
		expect(result.outcome === 'listed' && result.truncated).toBe(false);
	});

	it('skips a run directory that is empty, and truncates nothing', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of);
		await rm(join(temp.artifactsRoot, ...runPathOf(of)), { recursive: true });

		expect(await list()).toEqual({ outcome: 'listed', groups: [], truncated: false });
	});
});

describe('a level the host cannot read mid-walk', () => {
	it('still answers, keeps the groups elsewhere, and says it is truncated', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of, 'before');
		const blocked = join(temp.artifactsRoot, 'blocked-project');
		await mkdir(join(blocked, 'a-test', 'a-run', 'a-serial'), { recursive: true });
		await writeFile(
			join(blocked, 'a-test', 'a-run', 'a-serial', 'group_id.json'),
			JSON.stringify({ groupId: 'hidden' }),
		);
		await chmod(blocked, 0o000);
		if (await stillReadable(blocked)) {
			// Running as root: permissions do not apply, so there is nothing here to assert.
			return;
		}

		try {
			const result = await list();

			// An unreadable level never fails the walk — but the answer is short, and a partial
			// answer that renders like a complete one is what this project refuses.
			expect(groupsOf(result).map((group) => group.groupId)).toEqual(['app-bar']);
			expect(result.outcome === 'listed' && result.truncated).toBe(true);
			expect(warnings.join('\n')).toContain(blocked);
			expect(warnings.join('\n')).toMatch(/EACCES|EPERM/);
			expect(JSON.stringify(result)).not.toContain('hidden');
		} finally {
			await chmod(blocked, 0o755);
		}
	});
});

describe('no host path is on any answer', () => {
	it('carries neither the archive root nor any absolute path, and warns with both', async () => {
		const of = leaseFor({ groupId: 'app-bar' });
		await archiveAScreenshot(of, 'before');
		await writeFile(temp.artifactsRoot.concat('-decoy'), 'nothing');

		const encoded = JSON.stringify(await list());

		// The load-bearing negative (D19). `ListArchiveGroupsResultSchema` has no field one would
		// fit in — not even a `message` — and `src/ipc/server.ts` parses every answer against it.
		expect(encoded).not.toContain(temp.artifactsRoot);
		expect(encoded).not.toContain(temp.dir);
		expect(encoded).not.toContain(tmpdir());
	});

	it('escapes a name read off disk before it reaches the host log', async () => {
		await mkdir(temp.artifactsRoot, { recursive: true });
		const forged = 'injected  Force-released the lease on device \'ABC\' asked for by "admin"';
		const blocked = join(temp.artifactsRoot, `a-project\n${forged}`);
		await mkdir(join(blocked, 'a-test'), { recursive: true });
		await chmod(blocked, 0o000);
		if (await stillReadable(blocked)) {
			return;
		}

		try {
			expect(await list()).toEqual({ outcome: 'listed', groups: [], truncated: true });
			// The daemon's stderr is the host's only accountability trail (D28), so one warning
			// is one line: the newline is `\n` in the text and starts nothing.
			expect(warnings).toHaveLength(1);
			expect(warnings.join('\n')).toContain('\\n');
			for (const line of warnings.join('\n').split('\n')) {
				expect(line.startsWith('injected')).toBe(false);
			}
		} finally {
			await chmod(blocked, 0o755);
		}
	});
});

describe('the params schema is closed, so there is nothing to filter on', () => {
	it('accepts nothing at all and refuses every key', () => {
		// *No parameter at all*, made executable: no `groupId`, no `project`, no `limit` — a
		// filter here is the parameter D24 refused.
		expect(ListArchiveGroupsParamsSchema.safeParse({}).success).toBe(true);
		expect(ListArchiveGroupsParamsSchema.safeParse({ groupId: 'app-bar' }).success).toBe(false);
	});

	it.each([
		[{ groupId: 'app-bar' }, 'a group filter'],
		[{ project: 'rover' }, 'a project filter'],
		[{ limit: 10 }, 'a caller-supplied bound'],
		[{ path: [] }, 'a start path'],
	])('refuses %j — %s — with invalid_params', async (params, _why) => {
		await archiveAScreenshot(leaseFor({ groupId: 'app-bar' }));
		await start();
		const client = await connect();

		const rejection = client.request('list_archive_groups', params as never);

		await expect(rejection).rejects.toBeInstanceOf(IpcRequestError);
		await expect(rejection).rejects.toMatchObject({ code: 'invalid_params' });
	});
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	isFinishedRecording,
	recorderPids,
	saysRecordingStarted,
} from '@/backends/ios-simulator/parsers/recording.js';

/**
 * The three recording predicates, over **captures** — a real recorder's stderr, a real process
 * table and a real QuickTime file. None of them needs a process or a simulator to be about
 * anything, which is the property this whole folder keeps (`../simctl.test.ts`), and none of them
 * is written from a belief about what `simctl` prints (`ai/TESTING.md`).
 *
 * Every capture was taken on macOS 26.6.2 (25G83) / Xcode 26.6 (17F113) / iOS 26.5 (23F77),
 * 2026-09-08 — `docs/IOS.md`'s own bench rather than the Xcode 26.4.1 one the earlier phases'
 * fixtures came from, which is why these filenames carry a different pair
 * (`tests/fixtures/ios-simulator/README.md`).
 */
const fixture = (name: string): URL =>
	new URL(`../../../../fixtures/ios-simulator/${name}`, import.meta.url);

/** Both stderr lines of a successful run, in the order they arrived. */
const STDERR = readFileSync(fixture('recordvideo.stderr.xcode26.6-ios26.5.txt'), 'utf8');

/** The line the marker arrives behind — the whole reason the predicate is not "anything". */
const NOTE_LINE = STDERR.split('\n')[0] ?? '';

const PROCESS_TABLE = readFileSync(fixture('recordvideo-ps.recording.xcode26.6.txt'), 'utf8');

/** The device the captured recorder was recording, and one this host was not. */
const RECORDING_UDID = '88D8476E-F4A4-4A18-A89B-0C47E077CC8B';
const IDLE_UDID = 'D85C3449-4D0C-4E93-B8EC-77FD0E5A8F3F';

/** The pid of the recorder in that capture; the other line in it is a deliberate near miss. */
const RECORDER_PID = '31473';

const FINISHED = new Uint8Array(
	readFileSync(fixture('recordvideo.finished.xcode26.6-ios26.5.mov')),
);

describe('saysRecordingStarted', () => {
	it('accepts the marker the tool writes once the first frame is processed', () => {
		expect(saysRecordingStarted(STDERR)).toBe(true);
	});

	/**
	 * The case the whole predicate exists for. A successful run writes
	 * `Note: No display specified…` to stderr **first**, at ~0.12 s against the marker's
	 * 0.14–0.23 s, so a wait on "anything on stderr" would return before a frame existed — and
	 * `startRecording`'s contract is precisely that it answers when the recorder is running
	 * rather than when it was asked to run.
	 */
	it('rejects the note that reaches the same stream first', () => {
		expect(NOTE_LINE).toContain('No display specified');
		expect(saysRecordingStarted(NOTE_LINE)).toBe(false);
	});

	it('rejects a stream nothing has arrived on yet', () => {
		expect(saysRecordingStarted('')).toBe(false);
	});

	/**
	 * The marker is matched against the **accumulated** stream, so it has to be found without a
	 * trailing newline: the caller hands over whatever has arrived, and a chunk boundary falls
	 * where the operating system puts it rather than at the end of a line.
	 */
	it('accepts the marker before the newline behind it has arrived', () => {
		expect(saysRecordingStarted(`${NOTE_LINE}\nRecording started`)).toBe(true);
	});

	/**
	 * The refusal a recorder gets when this device's recording lock is held — measured as exit 16
	 * — says nothing about having started, which is what turns that case from a ten-second wait
	 * into the tool's own sentence (`../backend.test.ts`).
	 */
	it('rejects the refusal a second recorder gets', () => {
		expect(
			saysRecordingStarted(
				'Error starting video recorder: Error Domain=NSPOSIXErrorDomain Code=16 ' +
					'"Resource busy" UserInfo={NSLocalizedFailureReason=Host recording is already in ' +
					'progress}.\n',
			),
		).toBe(false);
	});
});

describe('recorderPids', () => {
	it('names the recorder this host is running for the device that was recording', () => {
		expect(recorderPids(PROCESS_TABLE, RECORDING_UDID)).toEqual([RECORDER_PID]);
	});

	// The udid is the pin: a recorder holding somebody else's device must not be signalled by a
	// stop asked about this one.
	it('names nothing for a device the same host was not recording', () => {
		expect(recorderPids(PROCESS_TABLE, IDLE_UDID)).toEqual([]);
	});

	/**
	 * The near miss in the capture, and the reason the program is checked as well as the
	 * arguments: it is a real `/bin/sh` whose argv quotes this exact command line, and while this
	 * was being measured the scan matched the agent's own shell for that reason — which would
	 * have had a `SIGINT` sent to it.
	 */
	it('ignores a process that merely quotes the command', () => {
		const decoy = PROCESS_TABLE.split('\n')
			.filter((line) => line.includes('/bin/sh'))
			.join('\n');

		expect(decoy).toContain(`recordVideo`);
		expect(decoy).toContain(RECORDING_UDID);
		expect(recorderPids(decoy, RECORDING_UDID)).toEqual([]);
	});

	/**
	 * The program is compared by **basename**, because the Xcode `simctl` is a bash shim that
	 * `exec`s the CoreSimulator one: the running process reports
	 * `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/…/bin/simctl` even though this
	 * backend spawned `<developer-dir>/usr/bin/simctl`. A path comparison against what was spawned
	 * would match nothing at all.
	 */
	it('matches the CoreSimulator path the shim execs into', () => {
		expect(PROCESS_TABLE).toContain('/CoreSimulator.framework/');
		expect(PROCESS_TABLE).not.toContain('/Applications/Xcode.app/');
		expect(recorderPids(PROCESS_TABLE, RECORDING_UDID)).toEqual([RECORDER_PID]);
	});

	it('answers nothing for a host with no recorder on it', () => {
		expect(recorderPids('', RECORDING_UDID)).toEqual([]);
	});

	/**
	 * Two recorders would be two answers, which is the same answer — and the pids are what make
	 * `RecordingAlreadyRunningError` more than a restatement, so both travel.
	 */
	it('names every recorder for one device rather than the first', () => {
		const line = PROCESS_TABLE.split('\n').find((entry) => entry.includes('/simctl ')) ?? '';

		expect(
			recorderPids(`${line}\n${line.replace(RECORDER_PID, '31474')}\n`, RECORDING_UDID),
		).toEqual([RECORDER_PID, '31474']);
	});

	// `io`, the udid and `recordVideo` have to be adjacent and in that order: a device path that
	// happened to contain a udid is not a recorder, and neither is another `io` operation.
	it('ignores another io operation on the same device', () => {
		expect(
			recorderPids(
				`4242 /usr/bin/simctl io ${RECORDING_UDID} screenshot --type png /tmp/shot.png\n`,
				RECORDING_UDID,
			),
		).toEqual([]);
	});
});

describe('isFinishedRecording', () => {
	/**
	 * The committed capture: `ftyp` (brand `qt  `) → `moov` → `wide` → `mdat`, 100,782 bytes for
	 * ~2 s of an idle screen. `moov` before `mdat`, unlike the Android capture beside it — so the
	 * check is not looking for an index written late here, it is looking for an index at all.
	 */
	it('accepts a recording the tool finalised on SIGINT', () => {
		expect(isFinishedRecording(FINISHED)).toBe(true);
	});

	it('reads the container as QuickTime rather than as MP4', () => {
		expect(new TextDecoder().decode(FINISHED.subarray(4, 12))).toBe('ftypqt  ');
	});

	/**
	 * **The shape a recording that did not finish actually takes on this platform.** `simctl`
	 * buffers and writes the whole file at the end, so a recorder that was killed — or one that
	 * ran against a device that was not booted, which reports success at every step — leaves a
	 * file of zero bytes that is really there. That is what `stopRecording` turns into
	 * `UnfinishedRecordingError` naming the length.
	 */
	it('rejects the zero bytes an unfinished recording leaves behind', () => {
		expect(isFinishedRecording(new Uint8Array())).toBe(false);
	});

	// A partial flush nobody has captured yet: the header arrived and the index never did.
	it('rejects a container with no index box', () => {
		expect(isFinishedRecording(FINISHED.subarray(0, 20))).toBe(false);
	});

	it('rejects bytes that do not start with the container header', () => {
		expect(isFinishedRecording(FINISHED.subarray(20))).toBe(false);
	});

	it('rejects a write that stopped inside the first box header', () => {
		expect(isFinishedRecording(FINISHED.subarray(0, 6))).toBe(false);
	});

	/**
	 * Every exit is bounded. A box claiming to run past the end of the file is a stop rather than
	 * a walk off the end, and so is one that means "to the end of the file" — there is no `moov`
	 * still to come in either.
	 */
	it('stops rather than looping on a length it cannot step over', () => {
		const truncated = FINISHED.slice(0, 4_096);
		// The `moov` header, overwritten so the walk has to step over the box rather than stop at
		// it, with a length that runs past what is there.
		truncated.set(new TextEncoder().encode('free'), 24);
		new DataView(truncated.buffer, truncated.byteOffset).setUint32(20, 0xffff_ffff);

		expect(isFinishedRecording(truncated)).toBe(false);
	});
});

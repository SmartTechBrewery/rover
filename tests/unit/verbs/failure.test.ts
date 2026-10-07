/**
 * `toVerbFailure` — every verb-layer error as a parseable answer, and everything else as
 * `null`.
 *
 * The two halves are asserted separately on purpose. The mapping is what a client branches
 * on; the `null` is what keeps a genuine host bug from being dressed up as an answer about
 * the device, and a catch-all branch would break exactly that without breaking any mapping
 * test.
 */

import { describe, expect, it } from 'vitest';
import {
	DeviceVanishedError,
	LogFilterRefusedError,
	MissingCapabilityError,
	NoRecordingRunningError,
	RecordingAlreadyRunningError,
	UnfinishedRecordingError,
	UnreadableScreenError,
	UnsupportedClearError,
	UnsupportedKeyError,
	UnsupportedTextError,
	WaitTimeoutError,
} from '@/core/errors.js';
import { parseDeviceSerial, parsePlatformId } from '@/core/ids.js';
import {
	AmbiguousTargetError,
	AppNotInForegroundError,
	ArtifactTooLargeError,
	CoveredByKeyboardError,
	FrameExtractionFailedError,
	FrameExtractionUnavailableError,
	FramesTooLargeError,
	InstallHookFailedError,
	InstallHookUndeclaredError,
	OffScreenPointError,
	ProjectNotRegisteredError,
	RecordingNormalisationFailedError,
	RecordingNormalisationUnavailableError,
	TargetNotFoundError,
	UnaddressableElementError,
} from '@/verbs/errors.js';
import { toVerbFailure, VerbFailureSchema } from '@/verbs/failure.js';
import { createMockScreenElement } from '../../helpers/factories.js';

const SERIAL = parseDeviceSerial('test-serial-1');
const save = createMockScreenElement({ id: 'save', text: 'Save' });
const cancel = createMockScreenElement({ id: 'cancel', text: 'Save changes' });

/** The failure, or a failure of the test rather than a `null` propagating into an assertion. */
function failureOf(error: unknown) {
	const failure = toVerbFailure(error);
	if (failure === null) {
		throw new Error(`Expected a verb failure, got null for ${String(error)}`);
	}
	return failure;
}

describe('a verb-layer error becomes a failure a client can branch on', () => {
	it('maps a missing capability, naming the capability, the device and the backend', () => {
		const error = new MissingCapabilityError(
			'canReadScreen',
			SERIAL,
			parsePlatformId('test-platform'),
			'Test',
		);

		expect(failureOf(error)).toEqual({
			kind: 'missing-capability',
			capability: 'canReadScreen',
			serial: SERIAL,
			platform: 'test-platform',
			backendLabel: 'Test',
			message: error.message,
		});
	});

	it('maps a target that was not found, carrying what was on screen instead', () => {
		const error = new TargetNotFoundError(SERIAL, "text containing 'Save'", 'an empty screen');

		expect(failureOf(error)).toEqual({
			kind: 'target-not-found',
			serial: SERIAL,
			lookedFor: "text containing 'Save'",
			found: 'an empty screen',
			message: error.message,
		});
	});

	it('maps an ambiguous target, carrying the candidates whole rather than as prose', () => {
		const error = new AmbiguousTargetError(
			SERIAL,
			"text containing 'Save'",
			[save, cancel],
			'pick one',
		);
		const failure = failureOf(error);

		// Whole elements, so a client can pick one by index without reading them back out of
		// the message.
		expect(failure).toMatchObject({ kind: 'ambiguous-target', candidates: [save, cancel] });
	});

	it('maps a caller-supplied point that is off the device', () => {
		const error = new OffScreenPointError(SERIAL, 900, 40, 360, 800);

		expect(failureOf(error)).toEqual({
			kind: 'off-screen-point',
			serial: SERIAL,
			x: 900,
			y: 40,
			widthDp: 360,
			heightDp: 800,
			message: error.message,
		});
	});

	it('maps an element that was found and cannot be acted on, keeping the two reasons apart', () => {
		const clipped = new UnaddressableElementError(
			SERIAL,
			"element 'save'",
			save,
			{ x: 60, y: 40 },
			360,
			800,
			'clipped',
		);

		expect(failureOf(clipped)).toMatchObject({
			kind: 'unaddressable-element',
			element: save,
			point: { x: 60, y: 40 },
			reason: 'clipped',
		});
	});

	/**
	 * #308. Without this branch a device that is merely showing a keyboard would answer as a
	 * host that broke. Both shapes: an element behind the point, and none — a caller's point
	 * or `scroll`'s computed start.
	 */
	it('maps a touch under the on-screen keyboard with every field, with and without an element', () => {
		const keyboard = { x: 0, y: 500, width: 360, height: 300 };
		const onElement = new CoveredByKeyboardError(
			SERIAL,
			"text containing 'Save'",
			save,
			{ x: 60, y: 620 },
			keyboard,
		);
		const onPoint = new CoveredByKeyboardError(
			SERIAL,
			'start of a scroll down across the screen',
			null,
			{ x: 180, y: 600 },
			keyboard,
		);

		expect(failureOf(onElement)).toEqual({
			kind: 'covered-by-keyboard',
			serial: SERIAL,
			lookedFor: "text containing 'Save'",
			element: save,
			point: { x: 60, y: 620 },
			keyboard,
			message: onElement.message,
		});
		expect(failureOf(onPoint)).toMatchObject({ kind: 'covered-by-keyboard', element: null });
		expect(onPoint.message).toContain('start of a scroll down across the screen');
		expect(onPoint.message).toContain('hide_keyboard');
	});

	/**
	 * #332. Without this branch a device merely showing another application would answer as a
	 * host that broke. Both shapes: another application named, and none the device could name.
	 */
	it('maps an expected application that is not in front, with and without one there', () => {
		const other = new AppNotInForegroundError(
			SERIAL,
			'type_text',
			'com.android.settings',
			'com.android.launcher3',
		);
		const unanswered = new AppNotInForegroundError(SERIAL, 'tap', 'com.android.settings', null);

		expect(failureOf(other)).toEqual({
			kind: 'app-not-in-foreground',
			serial: SERIAL,
			expectedApp: 'com.android.settings',
			foregroundApp: 'com.android.launcher3',
			message: other.message,
		});
		expect(other.message).toContain('type_text');
		expect(other.message).toContain(SERIAL);
		expect(other.message).toContain('com.android.launcher3');
		expect(other.message).toContain('launch_app');
		expect(failureOf(unanswered)).toMatchObject({
			kind: 'app-not-in-foreground',
			foregroundApp: null,
		});
		expect(unanswered.message).toContain('did not say');
		expect(unanswered.message).toContain('com.android.settings');
	});

	/**
	 * Without this branch the error falls out of `toVerbFailure` as unknown and the host
	 * reports that it broke, for a device that is merely still drawing its first frame (#299).
	 */
	it('maps a screen the device had not got yet, rather than letting it read as a host bug', () => {
		const error = new UnreadableScreenError(SERIAL, 'the screen reader had no window to dump');

		expect(failureOf(error)).toEqual({
			kind: 'unreadable-screen',
			serial: SERIAL,
			reason: 'the screen reader had no window to dump',
			message: error.message,
		});
	});

	it('maps text a device will not type, naming the characters rather than only the string', () => {
		const error = new UnsupportedTextError(
			SERIAL,
			'café',
			['U+00E9 ("é")'],
			'this device only types printable ASCII',
		);

		// Not `missing-capability`: the device does take input, and the way out is a different
		// string rather than a different device.
		expect(failureOf(error)).toEqual({
			kind: 'unsupported-text',
			serial: SERIAL,
			text: 'café',
			unsupported: ['U+00E9 ("é")'],
			message: error.message,
		});
	});
	/**
	 * The branch that keeps a large screen from being reported as a broken host.
	 *
	 * Without it this error is unmapped, `toVerbFailure` answers `null`, the handler rethrows
	 * and an agent reads `internal_error` — "the host broke" — about a device that merely
	 * showed it something big. Both numbers travel so the agent can tell which of the two it
	 * is looking at.
	 */
	it('maps an artifact over the bound, carrying the size and the bound it was over', () => {
		const error = new ArtifactTooLargeError(SERIAL, 9_000_000, 4_194_304);

		expect(failureOf(error)).toEqual({
			kind: 'artifact-too-large',
			serial: SERIAL,
			byteLength: 9_000_000,
			maxBytes: 4_194_304,
			message: error.message,
		});
	});

	it('maps a key the device has no equivalent for, naming the key rather than the capability', () => {
		const error = new UnsupportedKeyError(
			SERIAL,
			'recents',
			'this device has no app-switcher key and no gesture reachable from here',
		);

		// Not `missing-capability`: this device declares `canInput` and takes input, so the way
		// out is a different key rather than a different device — and `key` is what says which
		// one to stop asking for.
		expect(failureOf(error)).toEqual({
			kind: 'unsupported-key',
			serial: SERIAL,
			key: 'recents',
			message: error.message,
		});
		expect(error.message).toContain('recents');
	});

	it('maps a clear the device refuses, never as missing-capability (#309)', () => {
		const error = new UnsupportedClearError(SERIAL, 'select-all has not been measured here');

		// The device takes input and types; only the clear is refused, so the answer names the
		// clear and points at a route that still works rather than taking the device away.
		expect(failureOf(error)).toEqual({
			kind: 'unsupported-clear',
			serial: SERIAL,
			message: error.message,
		});
		expect(error.message).toContain('select-all has not been measured here');
		expect(error.message).toContain("press_key 'delete' with 'times'");
	});

	it('maps a log filter the device cannot apply, naming the filter', () => {
		const error = new LogFilterRefusedError(
			SERIAL,
			'since',
			'not in the form this device prints its timestamps in',
		);

		// Not `missing-capability`: every device reads its log, so the way out is the same read
		// without this filter — and `filter` is what says which one.
		expect(failureOf(error)).toEqual({
			kind: 'log-filter-refused',
			serial: SERIAL,
			filter: 'since',
			message: error.message,
		});
		expect(error.message).toContain("'since'");
	});

	it('carries the offending characters as escapes, so an invisible one is still actionable', () => {
		const error = new UnsupportedTextError(
			SERIAL,
			'a\tb',
			['U+0009 ("\\t")'],
			'this device only types printable ASCII',
		);
		const failure = failureOf(error);

		if (failure.kind !== 'unsupported-text') {
			throw new Error('the mapping above should have caught this');
		}
		// A tab and four spaces look identical in a message; the escape is what a caller can act
		// on without guessing which character to strip.
		expect(failure.unsupported).toEqual(['U+0009 ("\\t")']);
		expect(failure.message).toContain('U+0009');
	});

	/**
	 * The branch that keeps a race from being reported as a broken host. The device exited 0
	 * and the pull succeeded — what came off it was a file no player will open — so without
	 * this branch an agent reads `internal_error` about a recording that merely got cut off
	 * mid-write. The byte length travels because it is what separates "caught at the very
	 * start" from "the writer was killed at the end".
	 */
	it('maps a recording pulled unfinished, carrying the device and the byte length', () => {
		const error = new UnfinishedRecordingError(SERIAL, 3_232);

		expect(failureOf(error)).toEqual({
			kind: 'unfinished-recording',
			serial: SERIAL,
			byteLength: 3_232,
			message: error.message,
		});
	});

	/**
	 * The refusal that used to be a `wait-timeout` ten seconds later (#190). A recording held
	 * open makes "this device is already recording" an ordinary thing for an agent to run into,
	 * and the pids are what separate a recorder this host started from one it did not.
	 */
	it('maps a device that is already recording, naming the device and the pids', () => {
		const error = new RecordingAlreadyRunningError(SERIAL, ['29633', '29640']);

		expect(failureOf(error)).toEqual({
			kind: 'recording-already-running',
			serial: SERIAL,
			pids: ['29633', '29640'],
			message: error.message,
		});
	});

	/**
	 * Its opposite, and kept apart from `unfinished-recording` because the two ask opposite
	 * things of the caller: that one says ask again, this one says start one first. Without the
	 * branch a device that is simply idle answers `internal_error`.
	 */
	it('maps a stop with nothing recording, naming the device', () => {
		const error = new NoRecordingRunningError(SERIAL);

		expect(failureOf(error)).toEqual({
			kind: 'no-recording-running',
			serial: SERIAL,
			message: error.message,
		});
	});

	/**
	 * The branch that keeps an empty frame list from ever being an answer.
	 *
	 * Without it a host with no decoder installed has two ways to reply and both are wrong:
	 * `frames: []`, which reads as a recording in which nothing happened, or `internal_error`,
	 * which reads as a broken host for a machine that is merely missing a program. The program
	 * name and the reason travel because they are the remedy.
	 */
	it('maps a host that cannot slice a recording, naming the program and why it would not start', () => {
		const error = new FrameExtractionUnavailableError(SERIAL, 'ffmpeg', 'spawn ffmpeg ENOENT');

		expect(failureOf(error)).toEqual({
			kind: 'frame-extraction-unavailable',
			serial: SERIAL,
			program: 'ffmpeg',
			reason: 'spawn ffmpeg ENOENT',
			message: error.message,
		});
	});

	// Kept apart from the branch above because the two are fixed in different places: that one
	// says install a program, this one says something about these bytes.
	it('maps an extractor that ran and refused, carrying its exit code and its stderr', () => {
		const error = new FrameExtractionFailedError(
			SERIAL,
			'ffmpeg',
			183,
			'pipe:0: Invalid data found when processing input\n',
			'exited 183',
		);

		expect(failureOf(error)).toEqual({
			kind: 'frame-extraction-failed',
			serial: SERIAL,
			program: 'ffmpeg',
			exitCode: 183,
			stderr: 'pipe:0: Invalid data found when processing input\n',
			outcome: 'exited 183',
			message: error.message,
		});
	});

	/**
	 * The same pair again for the normalisation (#185), and the same reason it may never be an
	 * `internal_error`: a host without `ffmpeg` is a machine missing a program, not a broken
	 * one, and the alternative to naming it is handing over a recording no player will show
	 * anything for.
	 */
	it('maps a host that cannot normalise a recording, naming the program and why it would not start', () => {
		const error = new RecordingNormalisationUnavailableError(
			SERIAL,
			'ffmpeg',
			'spawn ffmpeg ENOENT',
		);

		expect(failureOf(error)).toEqual({
			kind: 'recording-normalisation-unavailable',
			serial: SERIAL,
			program: 'ffmpeg',
			reason: 'spawn ffmpeg ENOENT',
			message: error.message,
		});
	});

	// And the one that ran: an exit 0 that wrote nothing is a branch of its own here, because it
	// is the shape a build without the H.264 encoder takes and the one path by which an
	// un-normalised file could otherwise have become the answer.
	it('maps a normaliser that ran and produced nothing, carrying its exit code and its stderr', () => {
		const error = new RecordingNormalisationFailedError(
			SERIAL,
			'ffmpeg',
			0,
			'Unknown encoder libx264\n',
			'exited 0 without writing a recording at all',
		);

		expect(failureOf(error)).toEqual({
			kind: 'recording-normalisation-failed',
			serial: SERIAL,
			program: 'ffmpeg',
			exitCode: 0,
			stderr: 'Unknown encoder libx264\n',
			outcome: 'exited 0 without writing a recording at all',
			message: error.message,
		});
	});

	// Its own kind rather than a shape of `artifact-too-large`: that one is a capture that will
	// never fit, this one has two knobs, and `frames` is what says which is worth turning.
	it('maps frames over the budget, carrying the count and both byte numbers', () => {
		const error = new FramesTooLargeError(SERIAL, 30, 3_000_000, 1_572_864);

		expect(failureOf(error)).toEqual({
			kind: 'frames-too-large',
			serial: SERIAL,
			frames: 30,
			byteLength: 3_000_000,
			maxBytes: 1_572_864,
			message: error.message,
		});
	});

	/**
	 * The three ways a project install answers "no", and the reason all three are here: an
	 * `internal_error` would say the host broke over a hook file nobody wrote, and an `ok` would
	 * report an install that never ran. Each is a different next move for the agent — send the
	 * bytes, ask the operator, or read the build's own stderr.
	 */
	it('maps a project this host has never been told about, naming it', () => {
		const error = new ProjectNotRegisteredError(SERIAL, 'checkout-web');

		expect(failureOf(error)).toEqual({
			kind: 'project-not-registered',
			serial: SERIAL,
			project: 'checkout-web',
			message: error.message,
		});
	});

	it('maps a registered project whose hook file declares no install', () => {
		const error = new InstallHookUndeclaredError(SERIAL, 'checkout-web');

		expect(failureOf(error)).toEqual({
			kind: 'install-hook-undeclared',
			serial: SERIAL,
			project: 'checkout-web',
			message: error.message,
		});
	});

	/**
	 * #312: this message is the only place an agent meets this failure, so it carries the steer
	 * off the bypass — running the build's own install task, which unpinned lands on every device
	 * attached to the host — and names the remedy that is actually available.
	 */
	it('tells the agent not to install around the hook, and where a hook comes from', () => {
		const error = new InstallHookUndeclaredError(SERIAL, 'checkout-web');

		expect(error.message).toMatch(/every device attached/);
		expect(error.message).toContain('rover init');
	});

	// The exit code and the stderr tail travel together, because a non-zero exit is data and
	// neither half says on its own why a build refused.
	it('maps an install command that ran and failed, carrying its exit code and stderr', () => {
		const error = new InstallHookFailedError({
			serial: SERIAL,
			project: 'checkout-web',
			command: 'bash',
			exitCode: 1,
			signal: null,
			stderr: 'FAILURE: Build failed with an exception.\n',
			outcome: 'exited 1',
		});

		expect(failureOf(error)).toEqual({
			kind: 'install-hook-failed',
			serial: SERIAL,
			project: 'checkout-web',
			command: 'bash',
			exitCode: 1,
			signal: null,
			stderr: 'FAILURE: Build failed with an exception.\n',
			outcome: 'exited 1',
			message: error.message,
		});
	});

	// A command killed at its bound and one that never started both arrive with no exit code,
	// which is what `signal` and `outcome` are for.
	it('keeps a command killed at its bound distinguishable from one that never started', () => {
		const killed = failureOf(
			new InstallHookFailedError({
				serial: SERIAL,
				project: 'checkout-web',
				command: 'bash',
				exitCode: null,
				signal: 'SIGKILL',
				stderr: '',
				outcome: 'was killed by SIGKILL — its 300000ms budget is the likely reason',
			}),
		);
		const neverStarted = failureOf(
			new InstallHookFailedError({
				serial: SERIAL,
				project: 'checkout-web',
				command: 'build.sh',
				exitCode: null,
				signal: null,
				stderr: '',
				outcome: 'could not be started — spawn build.sh ENOENT',
			}),
		);

		expect(killed).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
		expect(neverStarted).toMatchObject({ exitCode: null, signal: null });
	});

	it('maps a wait that timed out, with the polls that make the elapsed time diagnosable', () => {
		const error = new WaitTimeoutError("text containing 'Save'", 'an empty screen', 5_000, 21);

		expect(failureOf(error)).toEqual({
			kind: 'wait-timeout',
			waitedFor: "text containing 'Save'",
			found: 'an empty screen',
			timeoutMs: 5_000,
			polls: 21,
			message: error.message,
		});
	});

	it.each([
		['a plain Error', new Error('the host broke')],
		['a device-layer error the verb layer does not answer with', new DeviceVanishedError(SERIAL)],
		['something that is not an Error at all', 'a string'],
	])('answers null for %s, so the caller rethrows', (_name, error) => {
		expect(toVerbFailure(error)).toBeNull();
	});
});

describe('a failure survives the trip to the agent', () => {
	it.each([
		[
			'missing-capability',
			new MissingCapabilityError('canInput', SERIAL, parsePlatformId('test-platform'), 'Test'),
		],
		['target-not-found', new TargetNotFoundError(SERIAL, "element 'save'", 'an empty screen')],
		[
			'ambiguous-target',
			new AmbiguousTargetError(SERIAL, "text containing 'Save'", [save, cancel], 'pick one'),
		],
		['off-screen-point', new OffScreenPointError(SERIAL, 900, 40, 360, 800)],
		[
			'unaddressable-element',
			new UnaddressableElementError(
				SERIAL,
				"element 'save'",
				save,
				{ x: 60, y: 40 },
				360,
				800,
				'off-screen',
			),
		],
		[
			'covered-by-keyboard',
			new CoveredByKeyboardError(
				SERIAL,
				"element 'save'",
				save,
				{ x: 60, y: 620 },
				{
					x: 0,
					y: 500,
					width: 360,
					height: 300,
				},
			),
		],
		[
			'covered-by-keyboard with no element',
			new CoveredByKeyboardError(
				SERIAL,
				'point (60, 620)',
				null,
				{ x: 60, y: 620 },
				{
					x: 0,
					y: 500,
					width: 360,
					height: 300,
				},
			),
		],
		[
			'app-not-in-foreground',
			new AppNotInForegroundError(
				SERIAL,
				'type_text',
				'com.android.settings',
				'com.android.launcher3',
			),
		],
		[
			'app-not-in-foreground with nothing named',
			new AppNotInForegroundError(SERIAL, 'tap', 'com.android.settings', null),
		],
		['wait-timeout', new WaitTimeoutError("element 'save'", 'an empty screen', 5_000, 21)],
		['unreadable-screen', new UnreadableScreenError(SERIAL, 'no window to dump')],
		[
			'unsupported-text',
			new UnsupportedTextError(
				SERIAL,
				'zażółć 🙂',
				['U+017C ("ż")', 'U+1F642 ("🙂")'],
				'only ASCII',
			),
		],
		['unsupported-key', new UnsupportedKeyError(SERIAL, 'recents', 'no key and no gesture')],
		['unsupported-clear', new UnsupportedClearError(SERIAL, 'no measured recipe')],
		['log-filter-refused', new LogFilterRefusedError(SERIAL, 'appId', 'no running process')],
		['artifact-too-large', new ArtifactTooLargeError(SERIAL, 9_000_000, 4_194_304)],
		['unfinished-recording', new UnfinishedRecordingError(SERIAL, 3_232)],
		['recording-already-running', new RecordingAlreadyRunningError(SERIAL, ['29633'])],
		['no-recording-running', new NoRecordingRunningError(SERIAL)],
		[
			'frame-extraction-unavailable',
			new FrameExtractionUnavailableError(SERIAL, 'ffmpeg', 'spawn ffmpeg ENOENT'),
		],
		[
			'frame-extraction-failed',
			new FrameExtractionFailedError(SERIAL, 'ffmpeg', 183, 'invalid data', 'exited 183'),
		],
		[
			'recording-normalisation-unavailable',
			new RecordingNormalisationUnavailableError(SERIAL, 'ffmpeg', 'spawn ffmpeg ENOENT'),
		],
		[
			'recording-normalisation-failed',
			new RecordingNormalisationFailedError(SERIAL, 'ffmpeg', 183, 'invalid data', 'exited 183'),
		],
		['frames-too-large', new FramesTooLargeError(SERIAL, 30, 3_000_000, 1_572_864)],
		['project-not-registered', new ProjectNotRegisteredError(SERIAL, 'checkout-web')],
		['install-hook-undeclared', new InstallHookUndeclaredError(SERIAL, 'checkout-web')],
		[
			'install-hook-failed',
			new InstallHookFailedError({
				serial: SERIAL,
				project: 'checkout-web',
				command: 'bash',
				exitCode: 1,
				signal: null,
				stderr: 'FAILURE: Build failed with an exception.',
				outcome: 'exited 1',
			}),
		],
	])('round-trips a %s failure through JSON and re-parses it equal', (_kind, error) => {
		const failure = failureOf(error);

		expect(VerbFailureSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
	});

	it('rejects a failure carrying a kind nobody produces', () => {
		expect(() => VerbFailureSchema.parse({ kind: 'device-on-fire', message: 'no' })).toThrow();
	});
});

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
	MissingCapabilityError,
	UnfinishedRecordingError,
	UnsupportedTextError,
	WaitTimeoutError,
} from '@/core/errors.js';
import { parseDeviceSerial, parsePlatformId } from '@/core/ids.js';
import {
	AmbiguousTargetError,
	ArtifactTooLargeError,
	FrameExtractionFailedError,
	FrameExtractionUnavailableError,
	FramesTooLargeError,
	InstallHookFailedError,
	InstallHookUndeclaredError,
	OffScreenPointError,
	ProjectNotRegisteredError,
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
		['wait-timeout', new WaitTimeoutError("element 'save'", 'an empty screen', 5_000, 21)],
		[
			'unsupported-text',
			new UnsupportedTextError(
				SERIAL,
				'zażółć 🙂',
				['U+017C ("ż")', 'U+1F642 ("🙂")'],
				'only ASCII',
			),
		],
		['artifact-too-large', new ArtifactTooLargeError(SERIAL, 9_000_000, 4_194_304)],
		['unfinished-recording', new UnfinishedRecordingError(SERIAL, 3_232)],
		[
			'frame-extraction-unavailable',
			new FrameExtractionUnavailableError(SERIAL, 'ffmpeg', 'spawn ffmpeg ENOENT'),
		],
		[
			'frame-extraction-failed',
			new FrameExtractionFailedError(SERIAL, 'ffmpeg', 183, 'invalid data', 'exited 183'),
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

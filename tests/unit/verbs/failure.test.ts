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
import { DeviceVanishedError, MissingCapabilityError, WaitTimeoutError } from '@/core/errors.js';
import { parseDeviceSerial, parsePlatformId } from '@/core/ids.js';
import {
	AmbiguousTargetError,
	ArtifactTooLargeError,
	OffScreenPointError,
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
		['artifact-too-large', new ArtifactTooLargeError(SERIAL, 9_000_000, 4_194_304)],
	])('round-trips a %s failure through JSON and re-parses it equal', (_kind, error) => {
		const failure = failureOf(error);

		expect(VerbFailureSchema.parse(JSON.parse(JSON.stringify(failure)))).toEqual(failure);
	});

	it('rejects a failure carrying a kind nobody produces', () => {
		expect(() => VerbFailureSchema.parse({ kind: 'device-on-fire', message: 'no' })).toThrow();
	});
});

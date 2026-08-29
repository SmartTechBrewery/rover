/**
 * Parser for `adb devices -l`.
 *
 * Lives under `src/backends/` because it knows one platform's tool by name; nothing
 * outside a backend folder may (ai/RULES.md §2). Pure: it takes the text a runner
 * already captured and returns a shape. Spawning, timeouts and exit codes belong to the
 * runner (R5), not here.
 *
 * **Nothing in this module reads the shape of a serial.** `emulator-5554` looks
 * structured and a phone's serial is an arbitrary string, so platform, model and
 * emulator-ness come from queries and never from an identifier
 * (ai/CODING_STANDARDS.md "Parsing external tool output"). That is why
 * {@link AdbDeviceSchema} has no platform, emulator or transport field: this module
 * reports the serial, the state and the `key:value` pairs adb itself printed, and
 * decides nothing. Emulator-ness is `./getprop.js`'s answer, from properties.
 */

import { z } from 'zod';

/**
 * The line adb prints before the device list. Everything above it is preamble: on
 * adb 37.0.0 a daemon that has to start first prints `* daemon not running; …` to
 * stderr, and a daemon that fails to start prints an `error: …` line — both of which
 * reach this parser whenever the caller merges the two streams. Anchoring on the header
 * rather than skipping known prefixes means an unrecognised preamble line cannot be
 * mistaken for a device (`error: cannot connect to daemon` otherwise parses as a device
 * with the serial `error:`).
 */
const DEVICE_LIST_HEADER = 'List of devices attached';

/** A `key:value` token in the `-l` tail — `product:`, `model:`, `device:`, `transport_id:`. */
const PROPERTY_TOKEN = /^[a-z][a-z0-9_]*:/;

/** The state adb reports for a device that can run a verb. */
const USABLE_STATE = 'device';

/**
 * One entry of the device list.
 *
 * `.strict()` so an added field is a load-time failure rather than a silent extension —
 * the key set is the acceptance criterion this module exists to hold.
 *
 * `state` is an open string, not an enum. The tokens adb can print (`device`, `offline`,
 * `unauthorized`, `authorizing`, `no permissions (…)`, `bootloader`, `recovery`, …) are
 * more than the fixtures capture, and writing that list from memory is the same mistake
 * as a hand-written fixture. {@link isUsable} encodes the one meaning that is verified.
 */
export const AdbDeviceSchema = z
	.object({
		serial: z.string().min(1),
		/** Raw state token. May contain spaces — some states adb prints are phrases. */
		state: z.string().min(1),
		/** The `key:value` tail adb printed. adb queried these; none is read off the serial. */
		properties: z.record(z.string(), z.string()),
	})
	.strict();

export type AdbDevice = z.infer<typeof AdbDeviceSchema>;

function splitProperties(tail: readonly string[]): {
	state: string;
	properties: Record<string, string>;
} {
	const properties: Record<string, string> = {};
	const stateWords: string[] = [];

	for (const token of tail) {
		if (PROPERTY_TOKEN.test(token)) {
			const separator = token.indexOf(':');
			properties[token.slice(0, separator)] = token.slice(separator + 1);
		} else if (Object.keys(properties).length === 0) {
			// State words only ever precede the properties, so a non-property token after
			// one has been seen is not part of the state.
			stateWords.push(token);
		}
	}

	return { state: stateWords.join(' '), properties };
}

/**
 * Parse `adb devices -l` output into one validated entry per attached device.
 *
 * Also parses plain `adb devices` (tab-separated, no property tail), which falls out of
 * the same tokenisation.
 *
 * Throws when the header is absent: adb reports meaningful failures with exit 0
 * (ai/CODING_STANDARDS.md), so output with no device list at all is a failure to
 * surface, not an empty list to hand back. An empty list *below* the header is a real
 * answer and returns `[]`.
 */
export function parseAdbDevices(stdout: string): AdbDevice[] {
	const lines = stdout.split('\n').map((line) => line.replace(/\r$/, '').trim());
	const headerIndex = lines.indexOf(DEVICE_LIST_HEADER);

	if (headerIndex === -1) {
		throw new Error(
			`adb devices: no '${DEVICE_LIST_HEADER}' header in output:\n${stdout.trimEnd()}`,
		);
	}

	return parseAdbDeviceLines(lines.slice(headerIndex + 1).join('\n'));
}

/**
 * The same device lines, with no header to anchor on — one entry per non-empty line.
 *
 * Its own entry point rather than a flag on {@link parseAdbDevices}, because the two are
 * reading different things. Command output is a whole stream with a preamble that can
 * carry anything, which is why that one refuses to guess without the header. This reads
 * the payload of a `track-devices` frame, where the length prefix is the delimiter, there
 * is no preamble at all — adb's banner and its `error:` line go to stderr — and a frame
 * either arrives whole or does not arrive. The payload is exactly the `-l` long format
 * with the `List of devices attached` header removed (verified on adb 37.0.1, 2026-08-29).
 *
 * An empty payload is a real answer here and returns `[]`: the tracker's way of saying
 * nothing is attached. That the *stream* ended is a different fact entirely, and it is
 * never expressed as bytes (PROJECT.md §6).
 */
export function parseAdbDeviceLines(text: string): AdbDevice[] {
	const devices: AdbDevice[] = [];

	for (const raw of text.split('\n')) {
		const line = raw.replace(/\r$/, '').trim();
		if (line.length === 0) continue;

		const [serial = '', ...tail] = line.split(/\s+/);
		const { state, properties } = splitProperties(tail);

		if (state.length === 0) {
			throw new Error(`adb devices: cannot parse device line: '${line}'`);
		}

		devices.push(AdbDeviceSchema.parse({ serial, state, properties }));
	}

	return devices;
}

/**
 * Whether a verb can run on this device.
 *
 * Only `device` can — `offline` and `unauthorized` are visible to the host and unusable,
 * which is the distinction `tests/device/setup.ts` already relies on.
 */
export function isUsable(device: AdbDevice): boolean {
	return device.state === USABLE_STATE;
}

/**
 * Parser for `adb shell getprop`.
 *
 * This is where "never parse a serial to infer anything" (ai/CODING_STANDARDS.md) is
 * actually paid for: `./devices.js` reports a serial and says nothing about it, and
 * emulator-vs-physical is decided **here**, from properties the device was asked for.
 *
 * Two entry points, because `getprop` prints two different things. {@link parseGetprop}
 * reads the `[key]: [value]` records of a full dump — every property, and what
 * `device_info` is built from. {@link parseOsVersion} reads the bare values of the two
 * properties the *enumeration* asks each device for, which is a narrower and much cheaper
 * read of facts the full dump also carries.
 */

import { z } from 'zod';

/** `[key]: [value]`. Non-greedy key plus an anchored trailing `]` so a value may hold `]`, `:` and spaces. */
const PROPERTY_LINE = /^\[(.+?)\]: \[(.*)\]$/;

/**
 * The same record with its value left open — `getprop` prints embedded newlines raw, so
 * `persist.sys.boot.reason.history` really does span four lines on a live device.
 */
const PROPERTY_OPENING = /^\[(.+?)\]: \[(.*)$/;

/**
 * Properties that mark a virtual device, checked in order.
 *
 * All four were observed together on an API 37 emulator (`sdk_gphone16k_arm64`,
 * 2026-08-29) — including `ro.kernel.qemu`, which is widely described as gone by now and
 * is not. Several are listed because they have not all survived every release, and any
 * one of them firing is enough. `ro.product.model` is deliberately absent: keying on a
 * model name starting with `sdk_` is serial-shape inference wearing a different hat.
 */
const EMULATOR_MARKERS: readonly {
	readonly key: string;
	readonly matches: (value: string) => boolean;
}[] = [
	{ key: 'ro.kernel.qemu', matches: (value) => value === '1' },
	{ key: 'ro.boot.qemu', matches: (value) => value === '1' },
	{ key: 'ro.hardware', matches: (value) => value === 'ranchu' },
	{
		key: 'ro.build.characteristics',
		// Comma-separated on devices that carry more than one characteristic.
		matches: (value) => value.split(',').includes('emulator'),
	},
];

/**
 * The device facts `getprop` answers.
 *
 * The named fields are nullable rather than throwing: "not found" is a `null` in this
 * codebase (ai/CODING_STANDARDS.md "Error handling"), and a caller that genuinely
 * requires an API level throws at its own boundary, where it can name the device.
 * `isEmulator` is not nullable — the absence of every marker is a real answer.
 */
export const DevicePropertiesSchema = z
	.object({
		/** Every `[key]: [value]` record, verbatim — embedded newlines included. */
		all: z.record(z.string(), z.string()),
		/** `ro.build.version.sdk`. */
		apiLevel: z.number().int().positive().nullable(),
		/** `ro.build.version.release` — the marketing version, e.g. `17`. */
		androidRelease: z.string().nullable(),
		/** `ro.product.model`. */
		model: z.string().nullable(),
		/** `ro.product.manufacturer`. */
		manufacturer: z.string().nullable(),
		isEmulator: z.boolean(),
	})
	.strict();

export type DeviceProperties = z.infer<typeof DevicePropertiesSchema>;

/**
 * Whether these properties describe a virtual device.
 *
 * Exported separately from {@link parseGetprop} so the negative case is testable against
 * a real dump with its markers removed, rather than against a remembered one.
 */
export function isEmulatorFromProps(all: Record<string, string>): boolean {
	return EMULATOR_MARKERS.some(({ key, matches }) => {
		const value = all[key];
		return value !== undefined && matches(value);
	});
}

function optional(all: Record<string, string>, key: string): string | null {
	const value = all[key];
	return value === undefined || value.length === 0 ? null : value;
}

/**
 * `ro.build.version.sdk` as a number, or `null` for anything that is not one.
 *
 * One helper for both parsers here, so the full dump and the narrow probe cannot come to
 * different conclusions about what an API level is.
 */
function toApiLevel(sdk: string | null): number | null {
	return sdk !== null && /^\d+$/.test(sdk) ? Number(sdk) : null;
}

/**
 * Continue a value that ran past `lines[start]`, which opened with `head`.
 *
 * Ends at the first line closing with `]`, and gives up at a line that opens the next
 * record — that one never closed, and one truncated property may not swallow the rest of
 * the dump. `last` is the final line consumed, so the caller resumes after it.
 */
function continueValue(
	lines: readonly string[],
	start: number,
	head: string,
): { readonly value: string; readonly last: number } | null {
	const parts = [head];

	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (PROPERTY_OPENING.test(line)) return null;
		if (line.endsWith(']')) {
			parts.push(line.slice(0, -1));
			return { value: parts.join('\n'), last: i };
		}
		parts.push(line);
	}

	return null;
}

/**
 * Parse `getprop` output. Lines that are not `[key]: [value]` are skipped rather than
 * fatal — an unparseable line is adb noise, and the hundreds of real properties around
 * it are still the answer.
 *
 * A value may contain newlines, so a record is not the same thing as a line: a `[key]: [`
 * whose line does not close is continued until one does, and the embedded newlines are
 * kept verbatim in {@link DeviceProperties.all}.
 */
export function parseGetprop(stdout: string): DeviceProperties {
	const all: Record<string, string> = {};
	const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''));

	for (let i = 0; i < lines.length; i++) {
		const complete = PROPERTY_LINE.exec(lines[i]);
		if (complete?.[1] !== undefined && complete[2] !== undefined) {
			all[complete[1]] = complete[2];
			continue;
		}

		const opening = PROPERTY_OPENING.exec(lines[i]);
		if (opening?.[1] === undefined || opening[2] === undefined) continue;

		const rest = continueValue(lines, i, opening[2]);
		if (rest === null) continue;

		all[opening[1]] = rest.value;
		i = rest.last;
	}

	return DevicePropertiesSchema.parse({
		all,
		apiLevel: toApiLevel(optional(all, 'ro.build.version.sdk')),
		androidRelease: optional(all, 'ro.build.version.release'),
		model: optional(all, 'ro.product.model'),
		manufacturer: optional(all, 'ro.product.manufacturer'),
		isEmulator: isEmulatorFromProps(all),
	});
}

/**
 * The two properties the enumeration probe reads, in the order the recipe prints them —
 * the marketing version first, the API level second (PROJECT.md §6).
 *
 * Exported so the backend builds its command line from the same list this parser reads
 * positionally, rather than from a second copy of the key names.
 */
export const OS_VERSION_PROPERTIES = ['ro.build.version.release', 'ro.build.version.sdk'] as const;

/**
 * The OS version of one device, as the narrow probe answers it.
 *
 * The same two facts {@link DeviceProperties} carries, under the same names and with the
 * same nullability — this is a cheaper way of reading them, not a different question.
 */
export const OsVersionSchema = z
	.object({
		/** `ro.build.version.release` — the marketing version, e.g. `17`. */
		androidRelease: z.string().nullable(),
		/** `ro.build.version.sdk`. */
		apiLevel: z.number().int().positive().nullable(),
	})
	.strict();

export type OsVersion = z.infer<typeof OsVersionSchema>;

/**
 * Parse the enumeration probe's output: the bare values of
 * {@link OS_VERSION_PROPERTIES}, one per line, in that order.
 *
 * Its own function rather than a flag on {@link parseGetprop}, because the two read
 * different text: that one reads the `[key]: [value]` records of a full dump, this one
 * reads values with no keys beside them. So the values are read **positionally**, which
 * `getprop` makes safe — a property the device does not have prints an *empty line*
 * rather than nothing at all and rather than failing the command, measured on API 37
 * (PROJECT.md §6). An empty or absent line is a `null`, on
 * {@link DeviceProperties}' terms.
 *
 * A trailing `\r` is stripped per line, for the reason every parser here does it: a
 * device shell that translates `\n` to `\r\n` is a trap this repo has already been bitten
 * by (PROJECT.md §6).
 */
export function parseOsVersion(stdout: string): OsVersion {
	const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''));
	const value = (index: number): string | null => {
		const line = lines[index];
		return line === undefined || line.length === 0 ? null : line;
	};

	return OsVersionSchema.parse({
		androidRelease: value(0),
		apiLevel: toApiLevel(value(1)),
	});
}

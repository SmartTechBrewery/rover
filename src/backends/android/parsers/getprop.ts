/**
 * Parser for `adb shell getprop`.
 *
 * This is where "never parse a serial to infer anything" (ai/CODING_STANDARDS.md) is
 * actually paid for: `./devices.js` reports a serial and says nothing about it, and
 * emulator-vs-physical is decided **here**, from properties the device was asked for.
 */

import { z } from 'zod';

/** `[key]: [value]`. Non-greedy key plus an anchored trailing `]` so a value may hold `]`, `:` and spaces. */
const PROPERTY_LINE = /^\[(.+?)\]: \[([\s\S]*)\]$/;

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
		/** Every `[key]: [value]` line, verbatim. */
		all: z.record(z.string(), z.string()),
		/** `ro.build.version.sdk`. */
		apiLevel: z.number().int().positive().nullable(),
		/** `ro.build.version.release` — the marketing version, e.g. `17`. */
		release: z.string().nullable(),
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
 * Parse `getprop` output. Lines that are not `[key]: [value]` are skipped rather than
 * fatal — an unparseable line is adb noise, and the hundreds of real properties around
 * it are still the answer.
 */
export function parseGetprop(stdout: string): DeviceProperties {
	const all: Record<string, string> = {};

	for (const rawLine of stdout.split('\n')) {
		const match = PROPERTY_LINE.exec(rawLine.replace(/\r$/, ''));
		if (match?.[1] !== undefined && match[2] !== undefined) {
			all[match[1]] = match[2];
		}
	}

	const sdk = optional(all, 'ro.build.version.sdk');
	const apiLevel = sdk !== null && /^\d+$/.test(sdk) ? Number(sdk) : null;

	return DevicePropertiesSchema.parse({
		all,
		apiLevel,
		release: optional(all, 'ro.build.version.release'),
		model: optional(all, 'ro.product.model'),
		manufacturer: optional(all, 'ro.product.manufacturer'),
		isEmulator: isEmulatorFromProps(all),
	});
}

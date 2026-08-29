/**
 * Parsers for `wm size` and `wm density`.
 *
 * Pure, like `./devices.js`: the runner (R5) owns the process, this owns the text.
 */

import { z } from 'zod';

/**
 * The reference density one dp is defined against. The px→dp scale is
 * `wm density ÷ 160`, **derived from the device every time and never from a screenshot's
 * width** (PROJECT.md §6): a screenshot-width scale is off by a few percent, which reads
 * as a pile of small imperfections rather than as an arithmetic error, and so survives
 * review. {@link WmDensity.scale} is the one place in Rover that ratio is computed.
 */
export const DP_BASELINE_DPI = 160;

const PHYSICAL_SIZE = /^Physical size:\s*(\d+)x(\d+)$/m;
const OVERRIDE_SIZE = /^Override size:\s*(\d+)x(\d+)$/m;
const PHYSICAL_DENSITY = /^Physical density:\s*(\d+)$/m;
const OVERRIDE_DENSITY = /^Override density:\s*(\d+)$/m;

/** Screen dimensions in physical pixels. */
export const DimensionsSchema = z
	.object({
		width: z.number().int().positive(),
		height: z.number().int().positive(),
	})
	.strict();
export type Dimensions = z.infer<typeof DimensionsSchema>;

/**
 * `wm size`. Most devices print only `Physical size:`; an `Override size:` line appears
 * once someone has run `wm size <w>x<h>`, and it is what the device actually renders at,
 * so `effective` — not `physical` — is what a coordinate belongs to.
 */
export const WmSizeSchema = z
	.object({
		physical: DimensionsSchema,
		override: DimensionsSchema.nullable(),
		effective: DimensionsSchema,
	})
	.strict();
export type WmSize = z.infer<typeof WmSizeSchema>;

/** `wm density`, plus the dp scale derived from it. */
export const WmDensitySchema = z
	.object({
		physical: z.number().int().positive(),
		override: z.number().int().positive().nullable(),
		effective: z.number().int().positive(),
		/** `effective / DP_BASELINE_DPI` — see {@link DP_BASELINE_DPI}. */
		scale: z.number().positive(),
	})
	.strict();
export type WmDensity = z.infer<typeof WmDensitySchema>;

/**
 * Throw naming the command and quoting the output verbatim.
 *
 * adb reports plenty of failures on stdout with exit 0 (ai/CODING_STANDARDS.md), so
 * `Error: Can't find service: window` arrives here as ordinary text. Surfacing it as-is
 * is the useful behaviour; returning `null` would hand the caller a plausible-looking
 * nothing, which is not what "return null for not found" is for.
 */
function unparseable(command: string, stdout: string): Error {
	return new Error(`${command}: no 'Physical' line in output:\n${stdout.trimEnd()}`);
}

/** `adb shell` may hand back CRLF; every parser here strips it rather than the fixtures. */
function normalise(stdout: string): string {
	return stdout.replace(/\r\n/g, '\n');
}

export function parseWmSize(stdout: string): WmSize {
	const text = normalise(stdout);
	const physicalMatch = PHYSICAL_SIZE.exec(text);
	if (!physicalMatch) throw unparseable('wm size', stdout);

	const overrideMatch = OVERRIDE_SIZE.exec(text);
	const toDimensions = (match: RegExpExecArray): Dimensions => ({
		width: Number(match[1]),
		height: Number(match[2]),
	});

	const physical = toDimensions(physicalMatch);
	const override = overrideMatch ? toDimensions(overrideMatch) : null;

	return WmSizeSchema.parse({ physical, override, effective: override ?? physical });
}

export function parseWmDensity(stdout: string): WmDensity {
	const text = normalise(stdout);
	const physicalMatch = PHYSICAL_DENSITY.exec(text);
	if (!physicalMatch) throw unparseable('wm density', stdout);

	const overrideMatch = OVERRIDE_DENSITY.exec(text);
	const physical = Number(physicalMatch[1]);
	const override = overrideMatch ? Number(overrideMatch[1]) : null;
	const effective = override ?? physical;

	return WmDensitySchema.parse({
		physical,
		override,
		effective,
		scale: effective / DP_BASELINE_DPI,
	});
}

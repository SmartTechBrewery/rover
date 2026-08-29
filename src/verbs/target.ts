/**
 * Turning a target into one point, from a screen read **during this call** (D12(a)).
 *
 * The signature is the rule. {@link resolveTarget} takes no screen, no element list and no
 * previously-read state, so there is nowhere for a caller to pass a coordinate worked out
 * a turn ago — "never trust a remembered coordinate" is structural here rather than a
 * convention a verb author has to keep. The one address that cannot be re-derived is a
 * caller-supplied point, which stays available as PROJECT.md §4's documented fallback, is
 * range-checked against the device, and is marked in the result as not having come from a
 * screen.
 */

import { z } from 'zod';
import { type Point, PointSchema, type ScreenElement } from '../core/device.js';
import { ElementIdSchema } from '../core/ids.js';
import { capabilityMethod, type VerbContext } from './context.js';
import {
	AmbiguousTargetError,
	describeScreen,
	OffScreenPointError,
	TargetNotFoundError,
} from './errors.js';
import type { ResolvedTarget } from './result.js';

/**
 * What a verb is pointed at.
 *
 * `.strict()` on every member, so `{ by: 'text', txt: 'Save' }` is a loud parse failure
 * rather than a target that matches everything on screen.
 */
export const TargetSchema = z.discriminatedUnion('by', [
	z
		.object({
			by: z.literal('text'),
			text: z.string().min(1),
			/** Whole-string equality instead of the default substring match. */
			exact: z.boolean().optional(),
			/**
			 * Which match to take when several are expected. Deliberate disambiguation — its
			 * absence is what makes two matches an {@link AmbiguousTargetError} rather than a
			 * silent first-match.
			 */
			index: z.number().int().nonnegative().optional(),
		})
		.strict(),
	z.object({ by: z.literal('element'), id: ElementIdSchema }).strict(),
	z.object({ by: z.literal('point'), at: PointSchema }).strict(),
]);
export type Target = z.infer<typeof TargetSchema>;

/** The target in the words the error messages use. */
function describeTarget(target: Target): string {
	switch (target.by) {
		case 'text': {
			const how = target.exact === true ? 'exactly' : 'containing';
			const at = target.index === undefined ? '' : ` at index ${target.index}`;
			return `text ${how} '${target.text}'${at}`;
		}
		case 'element':
			return `element '${target.id}'`;
		case 'point':
			return `point (${target.at.x}, ${target.at.y})`;
	}
}

/** The centre of an element — the point a verb acts on when it was named, not measured. */
export function centreOf(element: ScreenElement): Point {
	return {
		x: element.bounds.x + element.bounds.width / 2,
		y: element.bounds.y + element.bounds.height / 2,
	};
}

/**
 * Resolve a target against a screen captured now, or `null` when nothing matches.
 *
 * `null` rather than a throw for a miss, per ai/CODING_STANDARDS.md "Error handling" — a
 * caller polling for an element (R11 phase 3's waits) asks this question repeatedly and a
 * miss is its ordinary answer. Use {@link requireTarget} where a miss is a failure; it is
 * the one that can still name what was on screen instead.
 *
 * Ambiguity and an off-screen point *do* throw: neither is a lookup miss. One is a target
 * that under-specifies what it wants and the other is arithmetic that cannot be acted on.
 */
export async function resolveTarget(
	context: VerbContext,
	target: Target,
): Promise<ResolvedTarget | null> {
	return (await resolveOnFreshScreen(context, target)).resolved;
}

/**
 * {@link resolveTarget}, with a miss raised as a {@link TargetNotFoundError} naming what
 * was looked for **and what was on screen instead**.
 *
 * A separate function rather than a flag because it is the same screen read that answers
 * both halves of that message: re-reading the screen to describe it would describe a
 * different screen from the one the target missed.
 */
export async function requireTarget(context: VerbContext, target: Target): Promise<ResolvedTarget> {
	const { resolved, screen } = await resolveOnFreshScreen(context, target);
	if (resolved === null) {
		throw new TargetNotFoundError(
			context.serial,
			describeTarget(target),
			screen === null ? 'nothing readable' : describeScreen(screen),
		);
	}
	return resolved;
}

/** A resolution and the screen it was resolved against — `null` when none was read. */
interface Resolution {
	readonly resolved: ResolvedTarget | null;
	readonly screen: readonly ScreenElement[] | null;
}

async function resolveOnFreshScreen(context: VerbContext, target: Target): Promise<Resolution> {
	if (target.by === 'point') {
		return { resolved: await resolvePoint(context, target.at), screen: null };
	}

	const readScreen = capabilityMethod(context, 'canReadScreen', 'readScreen');
	const screen = await readScreen(context.serial);
	const candidates =
		target.by === 'text'
			? screen.filter((element) => matchesText(element, target.text, target.exact === true))
			: screen.filter((element) => element.id === target.id);
	const chosen = choose(context, target, candidates);

	return {
		resolved:
			chosen === null ? null : { source: 'screen', point: centreOf(chosen), element: chosen },
		screen,
	};
}

/**
 * A caller-supplied point, checked against the device rather than taken on trust.
 *
 * The device is asked *now* for its screen size: a point is the one target with no screen
 * read behind it, and an unchecked one dispatches an event into nowhere that the device
 * accepts silently. No conversion happens here — `Point` and `ScreenElement.bounds` are one
 * declared coordinate space and putting arithmetic in this layer is precisely the hidden
 * scale error PROJECT.md §6 warns about.
 */
async function resolvePoint(context: VerbContext, at: Point): Promise<ResolvedTarget> {
	const { screen } = await context.backend.deviceInfo(context.serial);
	const inside =
		Number.isFinite(at.x) &&
		Number.isFinite(at.y) &&
		at.x >= 0 &&
		at.y >= 0 &&
		at.x < screen.widthDp &&
		at.y < screen.heightDp;
	if (!inside) {
		throw new OffScreenPointError(context.serial, at.x, at.y, screen.widthDp, screen.heightDp);
	}
	return { source: 'caller-point', point: at, element: null };
}

/** Both strings an element can be named by, kept apart as `ScreenElement` keeps them. */
function matchesText(element: ScreenElement, wanted: string, exact: boolean): boolean {
	return [element.text, element.label].some((value) =>
		value === null ? false : exact ? value === wanted : value.includes(wanted),
	);
}

/**
 * One candidate, or `null` — and a throw when several matched and the caller did not say
 * which. Never the first of many, which is the false green this layer exists to prevent.
 */
function choose(
	context: VerbContext,
	target: Target,
	candidates: readonly ScreenElement[],
): ScreenElement | null {
	const index = target.by === 'text' ? target.index : undefined;
	if (index !== undefined) {
		return candidates[index] ?? null;
	}
	if (candidates.length > 1) {
		throw new AmbiguousTargetError(context.serial, describeTarget(target), candidates);
	}
	return candidates[0] ?? null;
}

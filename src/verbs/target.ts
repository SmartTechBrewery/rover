/**
 * Turning a target into one point, from a screen read **during this call** (D12(a)).
 *
 * The signature is the rule. {@link resolveTarget} takes no screen, no element list and no
 * previously-read state, so there is nowhere for a caller to pass a coordinate worked out
 * a turn ago — "never trust a remembered coordinate" is structural here rather than a
 * convention a verb author has to keep. The one address that cannot be re-derived is a
 * caller-supplied point, which stays available as PROJECT.md §4's documented fallback and
 * is marked in the result as not having come from a screen.
 *
 * **Every** point this module hands back is checked against the device's screen, whichever
 * way it was arrived at. An element the screen read reported is not evidence that the
 * element is *reachable*: a row scrolled out of its container comes back with bounds whose
 * second corner precedes its first (PROJECT.md §6), and the midpoint of that rectangle is
 * arithmetic rather than a place. Checking only the caller's coordinate would make the
 * screen-resolved path the less safe of the two, which is backwards.
 */

import { z } from 'zod';
import { type Point, PointSchema, type ScreenElement, type ScreenInfo } from '../core/device.js';
import { ElementIdSchema } from '../core/ids.js';
import { capabilityMethod, type VerbContext } from './context.js';
import {
	AmbiguousTargetError,
	describeScreen,
	OffScreenPointError,
	TargetNotFoundError,
	UnaddressableElementError,
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

/**
 * The targets a screen read can answer for — every kind but a caller-supplied point.
 *
 * A coordinate is the one address with no screen behind it, so a verb whose question *is*
 * about the screen's contents — is this there yet, has it gone away (`./wait-for.ts`) —
 * cannot be asked it: waiting for a point would resolve without ever waiting, and waiting
 * for one to disappear could never resolve at all. Making that a type rather than a
 * runtime check is the same instinct as {@link resolveTarget} taking no screen: the
 * question that cannot be answered is one nobody can ask.
 */
export type ScreenTarget = Exclude<Target, { by: 'point' }>;

/**
 * The targets an *absence* can be asked about — a screen target that names no position.
 *
 * `index` picks one match out of several so that a verb has one element to act on, and
 * that question does not survive being asked of a disappearance: an index is a position in
 * the current match list, never an identity, so it renumbers as soon as any sibling leaves.
 * Waiting for `index: 2` of three matching rows to go away would report success the moment
 * *any* one of the three went — the survivors renumber, slot 2 empties, and the row the
 * caller named is still on the screen. That is the false green this layer exists to
 * prevent, so `wait_until_gone` neither honours an index nor drops one: the question is
 * simply not one it can be asked. Same instinct as {@link ScreenTarget} excluding a point —
 * made a type error rather than a runtime surprise (`./wait-for.ts`).
 */
export type AbsenceTarget =
	| Extract<ScreenTarget, { by: 'element' }>
	| (Extract<ScreenTarget, { by: 'text' }> & { index?: never });

/** The target in the words the error messages use. */
export function describeTarget(target: Target): string {
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

/**
 * The centre of an element — the point a verb acts on when it was named, not measured.
 *
 * Pure arithmetic, and deliberately unguarded: whether that midpoint is somewhere a verb
 * may act is {@link requireAddressable}'s question, asked once with the device's screen in
 * hand. Splitting the two keeps the geometry testable on its own.
 */
export function centreOf(element: ScreenElement): Point {
	return {
		x: element.bounds.x + element.bounds.width / 2,
		y: element.bounds.y + element.bounds.height / 2,
	};
}

/** Whether a point is somewhere on the device, in the one space bounds and points share. */
function isOnScreen(at: Point, screen: ScreenInfo): boolean {
	return (
		Number.isFinite(at.x) &&
		Number.isFinite(at.y) &&
		at.x >= 0 &&
		at.y >= 0 &&
		at.x < screen.widthDp &&
		at.y < screen.heightDp
	);
}

/**
 * Resolve a target against a screen captured now, or `null` when nothing matches.
 *
 * `null` rather than a throw for a miss, per ai/CODING_STANDARDS.md "Error handling" — a
 * caller polling for an element (R11 phase 3's waits) asks this question repeatedly and a
 * miss is its ordinary answer. Use {@link requireTarget} where a miss is a failure; it is
 * the one that can still name what was on screen instead.
 *
 * Ambiguity, an off-screen point and an element that cannot be acted on *do* throw: none
 * of them is a lookup miss. One is a target that under-specifies what it wants, one is
 * arithmetic that cannot be acted on, and the third is an element that was found and is
 * still not somewhere a verb can touch — reporting that as "not found" while listing it
 * among what was on screen instead would send the caller looking for the wrong thing.
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
	const resolution = await resolveOnFreshScreen(context, target);
	if (resolution.resolved === null) {
		throw new TargetNotFoundError(
			context.serial,
			describeTarget(target),
			describeScreen(resolution.screen),
		);
	}
	return resolution.resolved;
}

/**
 * What matched, and the whole screen it was matched against.
 *
 * `matches` is deliberately every candidate rather than one: a caller asking *whether* the
 * target is on screen — `waitUntilGone` in `./wait-for.ts` — is not under-specifying
 * anything when two elements match, it is being told the thing is still there twice. Only
 * a caller that has to act on one of them has an ambiguity to resolve, which is why
 * choosing is {@link resolveOnScreen}'s step and not this one.
 */
export interface ScreenMatches {
	readonly matches: readonly ScreenElement[];
	readonly screen: readonly ScreenElement[];
}

/**
 * Everything on a screen read taken **now** that matches `target`.
 *
 * The read is inside this call for the reason the whole module is: a match found against a
 * screen someone else read is a claim about a screen that may no longer exist.
 */
export async function findOnScreen(
	context: VerbContext,
	target: ScreenTarget,
): Promise<ScreenMatches> {
	const readScreen = capabilityMethod(context, 'canReadScreen', 'readScreen');
	const elements = await readScreen(context.serial);
	const matches =
		target.by === 'text'
			? elements.filter((element) => matchesText(element, target.text, target.exact === true))
			: elements.filter((element) => element.id === target.id);
	return { matches, screen: elements };
}

/**
 * A resolution and the screen it was resolved against.
 *
 * A union rather than two nullable fields, because the pairing is not free: a miss always
 * carries the screen it missed on, so a caller can say what was there instead without a
 * defensive branch for a state that cannot occur.
 */
export type ScreenResolution =
	| { readonly resolved: ResolvedTarget; readonly screen: readonly ScreenElement[] }
	| { readonly resolved: null; readonly screen: readonly ScreenElement[] };

/**
 * The same union plus the one branch that has no screen behind it: `by: 'point'`, which
 * either resolves or throws and never reports a miss.
 */
type Resolution = ScreenResolution | { readonly resolved: ResolvedTarget; readonly screen: null };

/**
 * {@link resolveTarget} for the targets a screen answers for, handing back the screen too.
 *
 * Exported for the waits (`./wait-for.ts`), which need both halves from **one** read: the
 * resolution to answer with, and the screen it missed on to say what was there instead.
 * Reading the screen a second time to describe it would describe a different screen from
 * the one the target missed.
 */
export async function resolveOnScreen(
	context: VerbContext,
	target: ScreenTarget,
): Promise<ScreenResolution> {
	const { matches, screen } = await findOnScreen(context, target);
	const chosen = choose(context, target, matches);
	if (chosen === null) {
		return { resolved: null, screen };
	}

	// Only once something matched: a miss is the ordinary answer for a caller polling for
	// an element, and making it cost a `deviceInfo` — several device queries on a real
	// backend — would be paying for a check with nothing to check.
	const point = centreOf(chosen);
	const { screen: dimensions } = await context.backend.deviceInfo(context.serial);
	requireAddressable(context, target, chosen, point, dimensions);

	return { resolved: { source: 'screen', point, element: chosen }, screen };
}

async function resolveOnFreshScreen(context: VerbContext, target: Target): Promise<Resolution> {
	if (target.by === 'point') {
		return { resolved: await resolvePoint(context, target.at), screen: null };
	}
	return resolveOnScreen(context, target);
}

/**
 * The check that makes a screen-resolved point no more trusted than a caller-supplied one.
 *
 * Order matters: a degenerate rectangle is reported as degenerate rather than as
 * off-screen, because a clipped node's midpoint can easily land back on the screen — the
 * captured `[96,2798][399,2784]` in PROJECT.md §6 centres on a perfectly plausible-looking
 * coordinate — and "it is outside your screen" would then be a false explanation of a real
 * failure.
 */
function requireAddressable(
	context: VerbContext,
	target: Target,
	element: ScreenElement,
	point: Point,
	screen: ScreenInfo,
): void {
	const reason =
		element.bounds.width <= 0 || element.bounds.height <= 0
			? 'clipped'
			: isOnScreen(point, screen)
				? null
				: 'off-screen';
	if (reason !== null) {
		throw new UnaddressableElementError(
			context.serial,
			describeTarget(target),
			element,
			point,
			screen.widthDp,
			screen.heightDp,
			reason,
		);
	}
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
	if (!isOnScreen(at, screen)) {
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
		throw new AmbiguousTargetError(
			context.serial,
			describeTarget(target),
			candidates,
			remedyFor(target),
		);
	}
	return candidates[0] ?? null;
}

/**
 * The way out of an ambiguity, in the words that target kind can act on.
 *
 * `index` only exists on a text target (`TargetSchema` above), so offering it for an
 * element target would name a field a strict parse rejects — advice the caller cannot
 * take. Two elements sharing one id is not an under-specified target at all; it is the
 * backend contradicting the uniqueness `ElementId` implies, and the honest advice is to
 * address the element some other way.
 */
function remedyFor(target: Target): string {
	return target.by === 'element'
		? 'two elements sharing one id is a backend bug, not an ambiguous request — ' +
				're-target by text or by point until it is fixed'
		: 'name one with an explicit index rather than letting the first win';
}

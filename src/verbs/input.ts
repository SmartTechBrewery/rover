/**
 * The input verbs — `tap`, `long_press`, `swipe`, `scroll`, `type_text` and `press_key`
 * (PROJECT.md §4, "Input").
 *
 * Every one of them is a call to {@link performAction} (`./perform.ts`) and not one of them
 * reads a screen itself, which is what makes D12 true here **by construction** rather than by
 * four authors each remembering it: the capability is asserted before anything is dispatched,
 * the target is resolved from a read taken *inside* the call, and the state after the gesture
 * is captured after it. The waits are the deliberate exception to that spine and the only one
 * (`./wait-for.ts`); nothing here goes near `resultAfterAction`.
 *
 * **`long_press` is a drag from a point to the same point, held.** Never the long-press flag
 * on a key event that every guide reaches for — that flag applies to keys and not to touch,
 * and a long press built on it does nothing at all to something on the screen (PROJECT.md §6).
 * The hold is the *device's* own duration, handed to the drag as an argument, so nothing here
 * waits: a host-side sleep would be the same duration measured on the wrong machine, and there
 * is no sleep in this codebase for any reason (D12(b), ai/RULES.md §2).
 *
 * **`scroll`'s direction is where the content goes, not where the finger goes.** `scroll
 * 'down'` reveals what is further down the list, which is a drag *upwards* — the sense a
 * scrollbar and a wheel already have. That ambiguity is the trap in this verb, so the
 * convention is stated here and asserted in `tests/unit/verbs/input.test.ts` on the sign of the
 * drag rather than left to whoever reads the parameter name.
 *
 * **No new backend method.** `long_press` and `scroll` are both a `swipe` with different
 * arguments, and the backend's input methods are primitives on purpose (`src/core/device.ts`,
 * "The methods are **primitives**"): composing them here keeps a backend author's obligation
 * at four methods rather than six, and keeps the composition somewhere it is written once for
 * every platform.
 *
 * **`type_text` and `press_key` pass no target at all.** A key press addresses nothing on the
 * screen and neither does text going to whatever holds focus, so `PerformActionOptions.target`
 * is absent and the result's `target` is `null` — a fact about the verb rather than a
 * resolution that failed. That also means neither reads a screen before acting: there is
 * nothing to resolve, so an agent gets them on a device that cannot read its screen at all.
 *
 * **Neither verb knows how its argument reaches the device.** `type_text` hands the caller's
 * string to the backend byte for byte — quoting and whatever a device's own text injection
 * reads rather than types are the backend's, which is where the knowledge of a particular
 * device belongs (`src/core/device.ts`, ai/RULES.md §2). A string this layer had "helpfully"
 * escaped would arrive on screen with the escaping in it.
 */

import { z } from 'zod';
import type { DeviceKey, Point, Rect } from '../core/device.js';
import { capabilityMethod, type VerbContext } from './context.js';
import { performAction } from './perform.js';
import type { ActionResult, ResolvedTarget } from './result.js';
import { requireTarget, type ScreenTarget, type Target } from './target.js';

/**
 * How long {@link longPress} holds, when the caller does not say.
 *
 * The threshold this has to clear is a **device setting** rather than a constant: the capture
 * device raised a long-press menu at a 390 ms drag in place and did not at 380, matching the
 * 400 ms it reports as its own long-press timeout (PROJECT.md §6). So this sits comfortably
 * above that rather than on it — twice the measured value — because a device configured slower
 * would otherwise turn every long press into a plain tap, silently, with a successful-looking
 * result behind it. A caller that knows its device passes its own `durationMs`.
 *
 * A named constant and not configuration (ai/RULES.md §7): it reaches no environment variable
 * and no config file, and the per-call override is the whole escape hatch.
 */
export const LONG_PRESS_DURATION_MS = 800;

/**
 * How long {@link swipe} drags, when the caller does not say — a deliberate drag rather than a
 * flick, which is what a caller who named two targets is describing.
 */
export const SWIPE_DURATION_MS = 300;

/**
 * How long {@link scroll} drags, when the caller does not say.
 *
 * Longer than {@link SWIPE_DURATION_MS} on purpose. A drag that ends fast is a fling, and a
 * fling keeps travelling an unpredictable distance after the finger leaves — so the state the
 * result reports would be a screen that is still moving, which is the one thing D12(c) exists
 * to rule out. A slower drag stops where it was put.
 */
export const SCROLL_DURATION_MS = 600;

/**
 * Where a {@link scroll} goes **in the content** — further down the list, back up it, onward
 * through a horizontal pager — never which way the finger travels.
 *
 * The two are opposites and both are defensible, which is exactly why the choice is written
 * down rather than inferred: this is the sense a scrollbar, a wheel and a page-down key have,
 * and it is the one an agent asking to "scroll down to the button" means.
 */
export const ScrollDirectionSchema = z.enum(['up', 'down', 'left', 'right']);
export type ScrollDirection = z.infer<typeof ScrollDirectionSchema>;

/**
 * How long the gesture takes **on the device**, in milliseconds.
 *
 * Plain data with a default per verb, so a caller that says nothing gets the constant above
 * and a caller with a slower device is not stuck with it. Zero is a legitimate value — it is a
 * flick — and it is the device that spends the time, never this process.
 */
export interface GestureOptions {
	readonly durationMs?: number;
}

/** {@link GestureOptions} plus the region a scroll happens in. */
export interface ScrollOptions extends GestureOptions {
	/**
	 * The scrollable region — a pane, a list — or absent for the screen as a whole.
	 *
	 * A {@link ScreenTarget} and deliberately not a `Target`: a caller-supplied point has no
	 * extent, so it cannot say how far a scroll may travel or where it may start, and the only
	 * box left to fall back on would be the whole screen — a gesture with no relation to the
	 * anchor the result would then report. Same instinct as the waits refusing a point: the
	 * question that cannot be answered is one nobody can ask (`./target.ts`).
	 */
	readonly target?: ScreenTarget;
}

/**
 * Tap one target.
 *
 * By text or by element id, with `{ by: 'point' }` available as PROJECT.md §4's documented
 * fallback — and marked `source: 'caller-point'` in the result, so an agent can tell a tap
 * that hit a named element from one that hit a coordinate somebody worked out a turn ago.
 */
export async function tap(context: VerbContext, target: Target): Promise<ActionResult> {
	return performAction(context, {
		verb: 'tap',
		requires: ['canInput'],
		target,
		act: async (resolved) => {
			const tapAt = capabilityMethod(context, 'canInput', 'tap');
			await tapAt(context.serial, pointOf(resolved));
		},
	});
}

/**
 * Press one target and hold it.
 *
 * A drag from the resolved point to that same point, held for `durationMs` — see this
 * module's header for why it is that and never a long-press key event.
 */
export async function longPress(
	context: VerbContext,
	target: Target,
	options: GestureOptions = {},
): Promise<ActionResult> {
	const durationMs = options.durationMs ?? LONG_PRESS_DURATION_MS;

	return performAction(context, {
		verb: 'long_press',
		requires: ['canInput'],
		target,
		act: async (resolved) => {
			const drag = capabilityMethod(context, 'canInput', 'swipe');
			const at = pointOf(resolved);
			await drag(context.serial, at, at, durationMs);
		},
	});
}

/**
 * Drag from one target to another.
 *
 * `from` is what the spine resolves and what the result reports, because it is where the
 * gesture starts and the element the caller was addressing. `to` is resolved inside the
 * action, from a second read: the spine takes one target and this verb has two, and nothing
 * has happened on the device between the two reads — the gesture is still ahead of both — so
 * the whole cost is one extra screen read. Widening `PerformActionOptions` to carry a second
 * target would generalise the spine every verb shares for the one verb that needs it.
 */
export async function swipe(
	context: VerbContext,
	from: Target,
	to: Target,
	options: GestureOptions = {},
): Promise<ActionResult> {
	const durationMs = options.durationMs ?? SWIPE_DURATION_MS;

	return performAction(context, {
		verb: 'swipe',
		requires: ['canInput'],
		target: from,
		act: async (resolved) => {
			const destination = await requireTarget(context, to);
			const drag = capabilityMethod(context, 'canInput', 'swipe');
			await drag(context.serial, pointOf(resolved), destination.point, durationMs);
		},
	});
}

/**
 * Scroll the screen, or one region of it, in the direction the content moves.
 *
 * The gesture runs across the middle of the region: the resolved element's own rectangle when
 * a target was named, and the screen otherwise. Both are values already in hand — the element
 * the spine resolved, or the device's own report of its screen — so no coordinate here was
 * remembered from an earlier turn (D12(a)).
 *
 * **With no target this scrolls whatever occupies the middle of the screen**, which is not
 * always the list the caller meant: a drag that starts over an on-screen keyboard is read by
 * the keyboard, and PROJECT.md §6 records one that typed a word into a search field instead of
 * scrolling anything. Naming the region is what makes it the list's scroll rather than the
 * screen's, and nothing here can tell the two apart until a screen read is available (#13).
 *
 * The region is also taken as it was reported. A container whose rectangle extends past the
 * panel is dragged across its own middle, so an end of the gesture can land off the screen,
 * where the device accepts it in silence (PROJECT.md §6). That needs a rectangle more than
 * twice the screen's size in that axis for the middle half to reach an edge, and clamping it
 * would cost a second device query on every scroll — recorded rather than defended against,
 * the same trade the dp→px conversion records.
 */
export async function scroll(
	context: VerbContext,
	direction: ScrollDirection,
	options: ScrollOptions = {},
): Promise<ActionResult> {
	const durationMs = options.durationMs ?? SCROLL_DURATION_MS;

	return performAction(context, {
		verb: 'scroll',
		requires: ['canInput'],
		target: options.target,
		act: async (resolved) => {
			const box = resolved?.element?.bounds ?? (await screenBox(context));
			const { from, to } = dragAcross(box, direction);
			const drag = capabilityMethod(context, 'canInput', 'swipe');
			await drag(context.serial, from, to, durationMs);
		},
	});
}

/**
 * Type text into whatever currently has focus.
 *
 * **No target, by design.** An agent that wants text in a particular field taps it and then
 * types — `tap` already resolves an element from a screen read taken inside itself, and an
 * optional target here would be a second copy of that resolution for the one verb that does
 * not need it. The result's `target` is `null` for the same reason a key press's is: this
 * addressed no element.
 *
 * **The string is passed through untouched.** Whatever a device's own text entry treats as
 * special — a quote, a metacharacter, a per-platform substitution — is the backend's to
 * handle, and a device that cannot type a character at all answers `UnsupportedTextError`,
 * which reaches the agent as an `unsupported-text` failure naming the characters to change
 * (`./failure.ts`). Nothing here inspects the text, because every rule this layer could
 * apply would be one device's rule applied to all of them.
 *
 * Focus itself is not this verb's to guarantee and cannot be: nothing this layer can ask says
 * where the caret is until a screen read is available (#13). What the result does report is
 * the state after the typing, which is where an agent looks to see whether it landed.
 */
export async function typeText(context: VerbContext, text: string): Promise<ActionResult> {
	return performAction(context, {
		verb: 'type_text',
		requires: ['canInput'],
		act: async () => {
			const type = capabilityMethod(context, 'canInput', 'typeText');
			await type(context.serial, text);
		},
	});
}

/**
 * Press one of the device's own keys — `back`, `home`, `recents` or `wake`.
 *
 * `DeviceKey` is the whole vocabulary and it is `src/core/device.ts`'s, shared with the
 * backend and with the wire rather than restated here: a key this layer accepted and a
 * backend had no mapping for would be a press that reports success and does nothing.
 *
 * **The post-state is the interesting half.** `home` and `recents` change what is on screen
 * without anything on screen having been touched, so the `ActionResult`'s `after` is the only
 * evidence of what the press did — and on a backend that cannot read its screen it says so
 * (`unavailable`) rather than implying nothing changed.
 */
export async function pressKey(context: VerbContext, key: DeviceKey): Promise<ActionResult> {
	return performAction(context, {
		verb: 'press_key',
		requires: ['canInput'],
		act: async () => {
			const press = capabilityMethod(context, 'canInput', 'pressKey');
			await press(context.serial, key);
		},
	});
}

/**
 * How far into the region a scroll starts and ends, as a fraction of it.
 *
 * A quarter in from each edge, so the drag covers the middle half and neither end sits on an
 * edge a platform may have reserved for a gesture of its own — a scroll that begins on the very
 * edge of the screen is a back swipe or a notification pull on some devices, and that failure
 * looks exactly like a scroll that went the wrong way.
 */
const SCROLL_INSET = 0.25;

/** The screen as a rectangle in the one coordinate space points and bounds share. */
async function screenBox(context: VerbContext): Promise<Rect> {
	const { screen } = await context.backend.deviceInfo(context.serial);
	return { x: 0, y: 0, width: screen.widthDp, height: screen.heightDp };
}

/**
 * The two ends of a scroll's drag across `box` — the module header's convention as arithmetic.
 *
 * Reading `'down'` as a drag that ends *higher up* the box is the whole point: the content
 * comes with the finger, so travelling up the screen brings what is below into view.
 */
function dragAcross(box: Rect, direction: ScrollDirection): { from: Point; to: Point } {
	const midX = box.x + box.width / 2;
	const midY = box.y + box.height / 2;
	const left = box.x + box.width * SCROLL_INSET;
	const right = box.x + box.width * (1 - SCROLL_INSET);
	const top = box.y + box.height * SCROLL_INSET;
	const bottom = box.y + box.height * (1 - SCROLL_INSET);

	switch (direction) {
		case 'down':
			return { from: { x: midX, y: bottom }, to: { x: midX, y: top } };
		case 'up':
			return { from: { x: midX, y: top }, to: { x: midX, y: bottom } };
		case 'right':
			return { from: { x: right, y: midY }, to: { x: left, y: midY } };
		case 'left':
			return { from: { x: left, y: midY }, to: { x: right, y: midY } };
	}
}

/**
 * The point the spine resolved, for the verbs that always name a target.
 *
 * `null` is unreachable from the four verbs that call this — each passes one — but `act` is
 * typed for the two above that address nothing at all ({@link typeText}, {@link pressKey}), so
 * the impossibility is stated once here rather than assumed at four call sites.
 */
function pointOf(target: ResolvedTarget | null): Point {
	if (target === null) {
		throw new Error(
			'A gesture verb reached its action with no resolved target — it was handed to the ' +
				'spine without one, which is a wiring bug rather than anything the caller did',
		);
	}
	return target.point;
}

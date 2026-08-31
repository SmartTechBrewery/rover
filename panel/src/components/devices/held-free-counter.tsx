import { StatusLed } from './status-led.js';

/**
 * `● 2 held  ● 1 free` above the grid, in the page header's right-hand slot.
 *
 * It uses the very LEDs the cards use (`docs/DESIGN.md` §6) — the held one before the held count,
 * the free one in place of a separator. No `·`, and no glow.
 *
 * **A third term appears only when there is one to report** (#123): a device the host reports as
 * `unauthorized` or `offline` is neither held nor available, and folding it into either number
 * would make the badge claim a pool that is not there. On the ordinary screen — every device
 * `ready` — the badge is exactly the two terms the design settled, because the count is zero.
 *
 * **It agrees with the cards structurally, not by discipline.** The screen derives all three
 * numbers from the one array it renders and they sum to it, so there is no second source that could
 * disagree; this component is handed the counts and never counts anything itself.
 *
 * The design's markup puts a scanline inside this badge, blended. It is dropped: the texture is
 * confined to the navigation chrome, and `app-shell.test.tsx` asserts that nothing inside `<main>`
 * carries it (§5).
 */
export function HeldFreeCounter({
	held,
	free,
	notReady,
}: {
	readonly held: number;
	readonly free: number;
	readonly notReady: number;
}) {
	return (
		<div className="flex items-center gap-4 rounded-sm border-2 border-outline-variant bg-surface-container px-3 py-1.5">
			<span className="flex items-center gap-2 font-code-md text-code-md text-on-surface">
				<StatusLed tone="held" size="counter" />
				{held} held
			</span>
			<span className="flex items-center gap-2 font-code-md text-code-md text-on-surface">
				<StatusLed tone="free" size="counter" />
				{free} free
			</span>
			{notReady === 0 ? null : (
				<span className="flex items-center gap-2 font-code-md text-code-md text-on-surface">
					<StatusLed tone="not-ready" size="counter" />
					{notReady} not ready
				</span>
			)}
		</div>
	);
}

import { DeviceCard } from '@panel/components/devices/device-card.js';
import {
	ForceReleaseNotice,
	type SettledForceRelease,
} from '@panel/components/devices/force-release-notice.js';
import { HeldFreeCounter } from '@panel/components/devices/held-free-counter.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { QuietBanner } from '@panel/components/quiet-banner.js';
import { QuietPanel } from '@panel/components/quiet-panel.js';
import type { ListedDevice } from '@panel/devices/device-list.js';
import { useDeviceList } from '@panel/devices/device-list-provider.js';
import type { ForceReleaseAnswer } from '@panel/devices/force-release.js';
import { createRoute } from '@tanstack/react-router';
import { RefreshCwOff } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { rootRoute } from './__root.js';

/**
 * The panel's default view, against real host data.
 *
 * **Every state below is a state of this one screen** (`docs/DESIGN.md` §7). The breadcrumb, the
 * describing line and the header row's shape are the same in all of them — a header that differed
 * between them is most of what §3 exists to correct — and only the content area changes. The one
 * exception is the host being unreachable, which leaves the navigation nothing to reach and is
 * therefore a state of the whole page, rendered by `app.tsx` in place of the router.
 *
 * What the content area renders, and the difference between the rows — the last two are why this
 * is a table rather than a sentence:
 *
 * | The host's answer | What this renders |
 * | --- | --- |
 * | nothing yet | one quiet line, no spinner |
 * | devices | the grid, and the counter |
 * | an empty list | *No devices attached* — normal, common and finished (D21) |
 * | `stale` with a list | the banner, then the grid quieted as a set; lease fields untouched (D6) |
 * | `stale` with an empty list | *No view* — and never *nothing attached* |
 *
 * The counter is derived from the very array the cards come from, so "the counter agrees with the
 * cards" is structural rather than something to keep in step.
 *
 * **The one operator action's outcome is said here rather than on a card** (#122). This screen holds
 * it because the card that was acted on is about to go free or leave the grid, and it asks the poll
 * for a fresh answer the moment the host settles one — so the grid shows what happened without a
 * reload. There is at most one such line, because there is at most one such action.
 *
 * Exported for `devices.test.tsx`: a route's component is otherwise reachable only through a router
 * instance, and what is worth asserting here is which state renders which content.
 */
export function DevicesScreen() {
	const { state, refresh } = useDeviceList();
	const [settled, setSettled] = useState<SettledForceRelease | undefined>(undefined);
	const devices = state.status === 'ready' ? state.devices : [];
	/*
	 * Three buckets that sum to the grid, in the order they exclude each other (#123). A device the
	 * host reports as anything but `ready` cannot be leased, so counting it as free would claim a
	 * pool the host would refuse — the same wrong answer the card's `free` panel used to give.
	 * Held first, because a lease on a device that has since gone `offline` is still a lease and
	 * still the answer to "who do I ask".
	 */
	const held = devices.filter((device) => device.heldBy !== null).length;
	const notReady = devices.filter(
		(device) => device.heldBy === null && device.state !== 'ready',
	).length;

	/*
	 * The answer, and the fresh look that makes it visible. `refresh()` is what turns "the lease
	 * ended" into a card that says `free` without a reload — the interval gets there on its own
	 * within `POLL_MS`, and an operator who has just ended a lease should not have to watch for
	 * it. A refusal asks too: `not-held` means this card was already out of date, and `gone`
	 * means it is about to leave the grid entirely.
	 *
	 * The request that reached nothing settles nothing, so it never arrives here — it stays in the
	 * dialog, which stays open (§8, `force-release.ts`).
	 */
	const onForceReleaseSettled = (answer: ForceReleaseAnswer, device: ListedDevice): void => {
		if (answer.outcome !== 'released' && answer.outcome !== 'refused') {
			return;
		}
		setSettled({ answer, device });
		refresh();
	};

	return (
		<>
			<PageHeader
				trail={[{ label: 'Devices' }]}
				description="Monitoring attached physical and virtual devices."
				aside={
					devices.length === 0 ? undefined : (
						<HeldFreeCounter
							held={held}
							free={devices.length - held - notReady}
							notReady={notReady}
						/>
					)
				}
			/>
			{/*
			 * Above the content area, so it is above the grid — and still there when the grid is not.
			 * Force-releasing the last device on a host it has since left empties the list, and the
			 * line explaining why must not sit inside the branch it just emptied.
			 */}
			<ForceReleaseNotice onDismiss={() => setSettled(undefined)} settled={settled} />
			<Content onForceReleaseSettled={onForceReleaseSettled} />
		</>
	);
}

function Content({
	onForceReleaseSettled,
}: {
	readonly onForceReleaseSettled: (answer: ForceReleaseAnswer, device: ListedDevice) => void;
}) {
	const { state } = useDeviceList();

	if (state.status === 'loading') {
		/*
		 * One line, and no spinner — §5 has no exception for progress, and the sign-in boot probe
		 * set the precedent. It is not an empty list and must not read as one, which is the whole
		 * reason this is a state rather than an empty array.
		 */
		return (
			<p aria-live="polite" className="mt-8 font-code-md text-code-md text-on-surface-variant">
				Reading the host's device list.
			</p>
		);
	}

	if (state.status === 'unreachable') {
		// `app.tsx` renders that one in place of the router, so this screen is not mounted while it
		// holds. This narrows a type rather than describing a state anybody can reach, exactly as
		// `ProfileScreen`'s own guard does.
		return null;
	}

	if (state.devices.length === 0) {
		return state.stale ? <NoView /> : <NothingAttached />;
	}

	return (
		<>
			{state.stale ? (
				<HostViewNotCurrent>
					This hardware list is the last thing seen, not what is attached now. The lease details
					below are still accurate.
				</HostViewNotCurrent>
			) : null}
			{/*
			 * Column count follows the width available to the content, not a viewport breakpoint
			 * (§4). 300 rather than 350 because three cards plus their gutters have to fit the
			 * content width at the design's own size.
			 *
			 * The two halves of the ceiling, and neither works without the other (#126):
			 *
			 * `auto-fill` rather than `auto-fit` keeps the tracks a width can hold even when there
			 * is no card for them, so one attached device occupies **one** track. `auto-fit`
			 * collapses the empty ones and stretches that lone card across the whole content width,
			 * where a card carrying a serial, a model, a state and a lease block reads as a banner
			 * rather than as one of a set.
			 *
			 * The maximum is what caps the grid at three columns without a breakpoint anywhere: a
			 * fourth 300 px track needs 1260 px with its gutters and the grid never gets past 1180,
			 * so the fourth is arithmetically unreachable however wide the window is. Below that
			 * ceiling the count still steps 3 → 2 → 1 on the content box, which is §4's rule intact.
			 * 380 px is the implied card maximum: at the design's own size the content box is about
			 * 1104 px and three cards already come out near 354 px, so the ceiling leaves the design
			 * untouched at the size it was drawn for and only bites above it. Written as the
			 * arithmetic rather than as 1180 so the three, the card maximum and the gutter token
			 * stay legible — `--container-max` is not it, because 1280 has room for that fourth
			 * track.
			 *
			 * A stale grid is quieted **as a set**, which is a treatment of the whole list — whether
			 * these are still the attached devices — and never a rewriting of the data in it. The
			 * countdown keeps ticking and every lease field stays exact: `stale` is about the host's
			 * view of the hardware and says nothing about leases, which are the daemon's own
			 * bookkeeping with no view that could go stale (D6).
			 */}
			<div
				className={`mt-8 grid max-w-[calc(3*380px+2*var(--gutter))] grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-(--gutter) ${
					state.stale ? 'opacity-75' : ''
				}`}
			>
				{state.devices.map((device) => (
					<DeviceCard
						device={device}
						key={device.serial}
						onForceReleaseSettled={onForceReleaseSettled}
						receivedAtMs={state.receivedAtMs}
					/>
				))}
			</div>
		</>
	);
}

/**
 * Nothing is plugged into the machine — normal, common and *finished* (D21). Rover never starts an
 * emulator and never plugs in a phone; a person does, so until they do this is the correct state
 * rather than a fault.
 *
 * The treatment is `QuietPanel`'s, and the words are this screen's: it says what would change it,
 * and the counter is absent rather than reading `0 held · 0 free`, which would describe a pool.
 */
function NothingAttached() {
	return (
		<QuietPanel heading="No devices attached">
			To begin, attach a physical device with USB debugging enabled or start an emulator on the host
			machine.
		</QuietPanel>
	);
}

/**
 * The dangerous half of `stale`, and the state this screen had to design (§10).
 *
 * An empty list with `stale` set means *no view*, not *no devices* — it is visually identical to
 * *nothing attached* and means the opposite, so a person reading "nothing is attached" walks to the
 * machine and finds a phone sitting in the socket. That is not a visual preference; it is the
 * reason the state exists (D6).
 *
 * So it takes the **banner's** grey treatment rather than the *nothing attached* panel's: a
 * different surface, a different heading and different words. And it is one block rather than a
 * banner over a block, because the banner exists to caveat a list and there is no list here to
 * caveat — with nothing below it, the whole content area is the message, said once.
 *
 * The counter is absent for *nothing attached*'s reason and more sharply: `0 held · 0 free` would
 * describe an empty pool, which is the precise claim this state exists to refuse. There is no retry
 * control either — this is host state that resolves itself, and the poll is already asking.
 */
function NoView() {
	return (
		<HostViewNotCurrent>
			Rover cannot say what is attached to this machine. Its view of the hardware was interrupted,
			has not arrived yet, or is not running.
			<span className="mt-2 block">
				This is not the same as nothing being attached — a phone may well be plugged in.
			</span>
		</HostViewNotCurrent>
	);
}

/**
 * The grey block both `stale` states share: an uncertainty, not a fault. Nothing failed, so there
 * is no warning colour here and nothing near red (§7) — see `QuietBanner`, which is that treatment.
 *
 * One heading, one clause. `HOST VIEW NOT CURRENT // DATA STALE` became `HOST VIEW NOT CURRENT` for
 * the same reason the unreachable page's second clause went: it is either a restatement or a claim
 * the panel cannot support.
 */
function HostViewNotCurrent({ children }: { readonly children: ReactNode }) {
	return (
		<QuietBanner Icon={RefreshCwOff} heading="HOST VIEW NOT CURRENT">
			{children}
		</QuietBanner>
	);
}

export const devicesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/devices',
	component: DevicesScreen,
});

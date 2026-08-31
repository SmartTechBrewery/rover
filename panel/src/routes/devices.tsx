import { DeviceCard } from '@panel/components/devices/device-card.js';
import { HeldFreeCounter } from '@panel/components/devices/held-free-counter.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { useDeviceList } from '@panel/devices/device-list-provider.js';
import { createRoute } from '@tanstack/react-router';
import { RefreshCwOff } from 'lucide-react';
import type { ReactNode } from 'react';
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
 * Exported for `devices.test.tsx`: a route's component is otherwise reachable only through a router
 * instance, and what is worth asserting here is which state renders which content.
 */
export function DevicesScreen() {
	const { state } = useDeviceList();
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
			<Content />
		</>
	);
}

function Content() {
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
			 * A stale grid is quieted **as a set**, which is a treatment of the whole list — whether
			 * these are still the attached devices — and never a rewriting of the data in it. The
			 * countdown keeps ticking and every lease field stays exact: `stale` is about the host's
			 * view of the hardware and says nothing about leases, which are the daemon's own
			 * bookkeeping with no view that could go stale (D6).
			 */}
			<div
				className={`mt-8 grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-(--gutter) ${
					state.stale ? 'opacity-75' : ''
				}`}
			>
				{state.devices.map((device) => (
					<DeviceCard device={device} key={device.serial} receivedAtMs={state.receivedAtMs} />
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
 * No error colour, no warning icon, no spinner and nothing that suggests loading. **Not
 * "standby"** — that word describes a machine waiting to do something, and this one simply has
 * nothing plugged in. The counter is absent rather than reading `0 held · 0 free`, which would
 * describe a pool.
 */
function NothingAttached() {
	return (
		<section className="mt-8 flex justify-center">
			<div className="relative flex w-full max-w-2xl flex-col items-center border-2 border-outline-variant bg-surface-container-lowest p-12 text-center">
				{/*
				 * The design's corner accents. They are deliberately corners and not a dot-and-lines
				 * rule under the message: that reads as a progress track, which is the one impression
				 * this state must not give.
				 */}
				<span
					aria-hidden="true"
					className="absolute top-0 left-0 size-4 border-outline-variant border-t-2 border-l-2"
				/>
				<span
					aria-hidden="true"
					className="absolute top-0 right-0 size-4 border-outline-variant border-t-2 border-r-2"
				/>
				<span
					aria-hidden="true"
					className="absolute bottom-0 left-0 size-4 border-outline-variant border-b-2 border-l-2"
				/>
				<span
					aria-hidden="true"
					className="absolute right-0 bottom-0 size-4 border-outline-variant border-r-2 border-b-2"
				/>

				<h2 className="font-headline-sm text-headline-sm text-on-surface">No devices attached</h2>
				<p className="mt-6 max-w-lg font-body-lg text-body-lg text-on-surface-variant">
					To begin, attach a physical device with USB debugging enabled or start an emulator on the
					host machine.
				</p>
			</div>
		</section>
	);
}

/**
 * The dangerous half of `stale`, and the state this screen had to design (§9).
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
 * is no warning colour here and nothing near red (§7).
 *
 * One heading, one clause. `HOST VIEW NOT CURRENT // DATA STALE` became `HOST VIEW NOT CURRENT` for
 * the same reason the unreachable page's second clause went: it is either a restatement or a claim
 * the panel cannot support.
 */
function HostViewNotCurrent({ children }: { readonly children: ReactNode }) {
	return (
		<section className="mt-8 flex items-start gap-4 border-2 border-outline-variant bg-surface-variant p-4">
			<RefreshCwOff
				aria-hidden="true"
				className="shrink-0 text-outline"
				size={24}
				strokeWidth={2}
			/>
			<div>
				<h2 className="font-headline-sm text-headline-sm text-on-surface">HOST VIEW NOT CURRENT</h2>
				<p className="mt-2 max-w-3xl font-body-md text-body-md text-on-surface-variant">
					{children}
				</p>
			</div>
		</section>
	);
}

export const devicesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/devices',
	component: DevicesScreen,
});

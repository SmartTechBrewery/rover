import type { ListedDevice } from '@panel/devices/device-list.js';
import type { ForceReleaseAnswer } from '@panel/devices/force-release.js';
import { Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import { ForceReleaseControl } from './force-release-control.js';
import { LeaseCountdown } from './lease-countdown.js';
import { StatusLed } from './status-led.js';

/**
 * One device, held or free, exactly to `docs/DESIGN.md` §6.
 *
 * The header bar is **identical on every card** — a pale header was tried on the free card and
 * lost, because the green LED had almost no contrast on it. Free is signalled by the LED and by the
 * body, never by a different header.
 *
 * **The held card is the dimmer one.** §5: the screen answers "what can I use right now", so the
 * free device is the most legible thing on it. That is why `opacity-80` is on the held card and not
 * on the free one, and it is the opposite of what a first pass reaches for.
 *
 * Nothing in this tree truncates or ellipsises. A serial is the device's identity and the longest
 * string on the card; it wraps.
 *
 * **One control, and only on a held card** (#122). Force-releasing a lease is the panel's one
 * operator action; it sits inside the lease panel, below the data it acts on, and a card with no
 * lease has nothing for it to end. What the answer to it says is not said here — see
 * `force-release-notice.tsx`.
 *
 * **No `STATE` field, but the device state is not ignored.** The card already says a device is held
 * three times over (`ACTIVE LEASE`, the LED, the counter above the grid), so there is no `STATE`
 * row. What adb reports about the hardware is a different fact, and it is not a row either — it is
 * what the body *says* when the device is not held: a device the host reports as `unauthorized` or
 * `offline` cannot be leased (`src/daemon/lease-handlers.ts` refuses it `not-ready`), so printing
 * `free` on it would be a positive claim the host will not honour.
 */
export function DeviceCard({
	device,
	receivedAtMs,
	onForceReleaseSettled,
}: {
	readonly device: ListedDevice;
	/** When the answer this card renders arrived, which is the countdown's base. */
	readonly receivedAtMs: number;
	/**
	 * A force-release the host answered. It is reported *up*, because this card is about to go free
	 * or leave the grid and cannot outlive the news about itself (`force-release-notice.tsx`).
	 */
	readonly onForceReleaseSettled: (answer: ForceReleaseAnswer, device: ListedDevice) => void;
}) {
	const lease = device.heldBy;
	// Anything but the exact word is not usable (`device-list.ts`), which is the safe direction to
	// be wrong in if a newer daemon ever adds a fourth state.
	const ready = device.state === 'ready';

	return (
		<article
			className={`flex flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface-container ${
				lease === null ? '' : 'opacity-80'
			}`}
		>
			<div className="flex items-center justify-between gap-3 border-outline-variant border-b-2 bg-surface-container-high px-4 py-2 text-on-surface-variant">
				<span className="flex min-w-0 items-center gap-2">
					<Smartphone aria-hidden="true" size={18} strokeWidth={2} />
					{/*
					 * The model, or the serial when the host could not read one. The header's job is
					 * to identify the device, and the serial always can.
					 */}
					<span className="break-words font-label-caps text-label-caps">
						{device.model ?? device.serial}
					</span>
				</span>
				{/*
				 * The LED follows the body: held is blue, free is green, and a device that is
				 * neither is grey. It must never be the free green here — that is the one colour on
				 * this card that reads as "take me".
				 */}
				<StatusLed tone={lease !== null ? 'held' : ready ? 'free' : 'not-ready'} />
			</div>

			<div className="flex flex-1 flex-col gap-4 p-4">
				{/*
				 * One grid rather than a row of nested wrappers, because a `<dl>` may hold a `<div>`
				 * per term-and-value pair and not a `<div>` of them. `SERIAL` spans both columns: it
				 * is the longest string on the card and an early two-column layout ran it straight
				 * into the platform value.
				 */}
				<dl className="grid grid-cols-2 gap-3">
					<Field className="col-span-2" label="Serial" value={device.serial} tone="serial" />
					{/* Two separate fields, never concatenated: `Android` is the platform, `14` is the
					    version. */}
					<Field label="Platform" value={device.platform} />
					{/*
					 * A null `osVersion` is a real answer — commonly a device waiting on its
					 * authorization prompt — so the field says `unknown` rather than disappearing.
					 * This is one of the card's two fixed columns, and dropping it leaves the row
					 * lopsided, so the gap is named rather than closed up (`docs/DESIGN.md` §6).
					 */}
					<Field label="OS version" value={device.osVersion ?? 'unknown'} />
				</dl>

				{/*
				 * Three bodies in one slot, and the order is the point. A lease is rendered whatever
				 * the hardware state is — the lease is the daemon's own bookkeeping and stays exact
				 * (D6's reasoning about `stale`, one level down). Only when nothing holds the device
				 * does its state decide between *free* and *not usable*.
				 */}
				{lease !== null ? (
					<LeasePanel
						device={device}
						lease={lease}
						onForceReleaseSettled={onForceReleaseSettled}
						receivedAtMs={receivedAtMs}
					/>
				) : ready ? (
					<FreePanel />
				) : (
					<NotReadyPanel state={device.state} />
				)}
			</div>
		</article>
	);
}

/**
 * The lease, in §6's order and for §6's reason: what is happening on the phone right now comes
 * before who to go and ask about it.
 */
function LeasePanel({
	device,
	lease,
	receivedAtMs,
	onForceReleaseSettled,
}: {
	readonly device: ListedDevice;
	readonly lease: NonNullable<ListedDevice['heldBy']>;
	readonly receivedAtMs: number;
	readonly onForceReleaseSettled: (answer: ForceReleaseAnswer, device: ListedDevice) => void;
}) {
	return (
		<div className="mt-auto rounded-sm border border-outline-variant bg-surface-container-high p-3">
			<div className="flex items-center justify-between gap-3 border-outline-variant border-b pb-2">
				<span className="font-label-caps text-label-caps text-on-surface-variant uppercase">
					Active lease
				</span>
				<LeaseCountdown expiresInMs={lease.expiresInMs} receivedAtMs={receivedAtMs} />
			</div>
			<dl className="mt-3 grid grid-cols-2 gap-3">
				{/*
				 * Never shortened to `TEST`, which reads as a category and makes the panel look like
				 * something it is not (§2, third recurrence). Always present: a lease cannot be taken
				 * without a test name (D22, as amended #129).
				 */}
				<Field className="col-span-2" label="Test name" value={lease.testName} tone="lease" />
				<Field label="Owner" value={lease.owner} />
				<Field label="Project" value={lease.project} />
				{/*
				 * Rendered exactly as the host sent it — the whole ISO-8601 instant with its `Z`,
				 * never truncated to `14:02 UTC` as the design's mock data shows it, and never
				 * differenced against this machine's clock. It is the host's clock, and the only
				 * honest relative number on this card is the countdown (`countdown.ts`, D17).
				 */}
				<Field className="col-span-2" label="Granted" value={lease.grantedAt} />
			</dl>
			{/*
			 * Below `GRANTED`, so everything the action would end is read before the control that
			 * ends it is reached (`docs/DESIGN.md` §7).
			 */}
			<ForceReleaseControl
				device={device}
				lease={lease}
				onSettled={onForceReleaseSettled}
				receivedAtMs={receivedAtMs}
			/>
		</div>
	);
}

/**
 * The free device, in the place the lease panel occupies. A phone icon and the word `free` — the
 * icon was originally a plug pulled from its socket, which means "disconnected", the opposite of
 * what this card says.
 */
function FreePanel() {
	return (
		<div className="mt-auto flex flex-col items-center gap-2 rounded-sm border border-outline-variant border-dashed bg-surface p-6 text-center">
			<Smartphone aria-hidden="true" className="text-tertiary" size={32} strokeWidth={2} />
			<span className="font-code-md text-code-md text-tertiary">free</span>
		</div>
	);
}

/**
 * The device nothing holds and nothing can take: attached, listed, and reported by the host as
 * `unauthorized` or `offline` (#123).
 *
 * It occupies the free panel's slot and takes its shape, so the grid still reads as one set of
 * cards — and **none of its colour**. Green is what this screen uses to say "take this one", and
 * the host would refuse a lease on this device (`not-ready`), so the word `free` and the tertiary
 * treatment are both wrong here. Grey rather than a warning colour: `docs/DESIGN.md` §5's rule that
 * there is no red or orange device state still holds, and nothing has gone wrong — a phone waiting
 * on its RSA prompt is an ordinary thing to walk past on the way to the machine.
 *
 * **The state is printed verbatim**, `unauthorized` and not "Not authorized", for the reason §6
 * gives about `platform`: a display table mapping the wire's words onto prettier ones is a branch
 * on host vocabulary in shared code, and `rover list`'s `STATE` column already prints these words.
 * The line beneath it is deliberately the same in every state, so no state gets its own advice and
 * no branch is needed to give it.
 */
function NotReadyPanel({ state }: { readonly state: string }) {
	return (
		<div className="mt-auto flex flex-col items-center gap-2 rounded-sm border border-outline-variant border-dashed bg-surface p-6 text-center">
			<Smartphone aria-hidden="true" className="text-outline" size={32} strokeWidth={2} />
			<span className="font-code-md text-code-md text-on-surface-variant">{state}</span>
			<span className="font-body-md text-body-md text-on-surface-variant">
				Attached, but not available to lease.
			</span>
		</div>
	);
}

/** A caps label over its value in the monospace face — the card anatomy §6 settles. */
function Field({
	label,
	value,
	className,
	tone = 'plain',
}: {
	readonly label: string;
	readonly value: ReactNode;
	readonly className?: string;
	readonly tone?: 'plain' | 'serial' | 'lease';
}) {
	const colour = tone === 'plain' ? 'text-on-surface' : 'text-primary';
	// `break-all` on the serial and `break-words` elsewhere: a serial is one unbroken machine string
	// with nowhere to break politely, and clipping it is what §6 forbids.
	const wrap = tone === 'serial' ? 'break-all' : 'break-words';
	return (
		<div className={className}>
			<dt className="font-label-caps text-label-caps text-on-surface-variant uppercase">{label}</dt>
			<dd className={`mt-2 font-code-md text-code-md ${colour} ${wrap}`}>{value}</dd>
		</div>
	);
}

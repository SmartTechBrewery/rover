import type { ListedDevice } from '@panel/devices/device-list.js';
import type { ForceReleaseAnswer } from '@panel/devices/force-release.js';

/**
 * A settled force-release and the device it was about, held together because the line needs both:
 * the answer names the lease that ended, and the device names the hardware — which the grid may no
 * longer be listing by the time anybody reads it.
 */
export interface SettledForceRelease {
	/** The request that reached nothing never gets here — it settled nothing, and is not one (§8). */
	readonly answer: Extract<ForceReleaseAnswer, { outcome: 'released' | 'refused' }>;
	readonly device: ListedDevice;
}

/**
 * What a force-release settled, said above the grid.
 *
 * **Three answers that must not collapse into one** (`docs/DESIGN.md` §7). A lease that ended, a
 * lease that had already ended on its own, and a device that is not on this host any more are three
 * different pieces of news; the second and third both mean "nothing was released" and mean nothing
 * else alike.
 *
 * **Above the grid rather than on a card, for all three.** The `gone` line has to be — its card is
 * out of the grid by the time the line exists. The other two are here for a reason of the same
 * kind: the control lives inside the lease panel, so the lease ending unmounts the only place a
 * card could have said so, and §6's card anatomy has no row for a fact that has already stopped
 * being true of it.
 *
 * **It stays until dismissed**, rather than until the next poll: a line the poll clears is a line
 * the operator may never have read, and this is the only place the panel explains why a confirmed
 * action changed nothing. Ordinary text, no colour of alarm and no icon of alarm — the panel did
 * what was asked, or says what there was to do instead (§5).
 *
 * The region is rendered in both states, empty when there is nothing to say, so it exists *before*
 * its text does — a live region created together with its content is announced unreliably, which
 * `Profile`'s sign-out line settled already.
 */
export function ForceReleaseNotice({
	settled,
	onDismiss,
}: {
	readonly settled: SettledForceRelease | undefined;
	readonly onDismiss: () => void;
}) {
	return (
		<div aria-live="polite">
			{settled === undefined ? null : (
				<section className="mt-8 flex items-start justify-between gap-4 border-2 border-outline-variant bg-surface-container-low p-4">
					<p className="max-w-3xl font-body-md text-body-md text-on-surface">
						{said(settled.answer, nameOf(settled.device))}
					</p>
					{/*
					 * Recessive, like every other control in this panel, and labelled by what it does to
					 * this line rather than by what it does to a device.
					 */}
					<button
						className="shrink-0 rounded-sm border-2 border-outline px-4 py-2 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim"
						onClick={onDismiss}
						type="button"
					>
						Dismiss
					</button>
				</section>
			)}
		</div>
	);
}

/**
 * The model and the serial that is the device's real identity, because the card carrying both may
 * already be gone from the grid — the serial in full, never shortened (§6).
 */
function nameOf(device: ListedDevice): string {
	return device.model === null ? device.serial : `${device.model} (${device.serial})`;
}

/**
 * One sentence per answer, in the vocabulary §7 settles.
 *
 * The lease named in the `released` line is the host's own projection, taken the instant before the
 * lease ended, rather than whatever the card happened to be showing when the operator clicked — the
 * whole reason the answer carries it.
 *
 * `gone` and `not-attached` share a line on purpose. They are two facts about the *host* — a device
 * it cannot see at all, and one it can see but does not own (D6, D18) — and exactly one fact for the
 * person reading this: that device is not on this host, so there was nothing to release and nothing
 * left to show either.
 */
function said(answer: SettledForceRelease['answer'], name: string): string {
	if (answer.outcome === 'released') {
		return `The lease ${answer.heldBy.owner} held on ${name} for ${answer.heldBy.project} has ended. The device is free.`;
	}
	if (answer.reason === 'not-held') {
		return `That lease had already ended on its own, so there was nothing to release on ${name}. The device is free either way.`;
	}
	return `${name} is no longer attached to this host, so there was nothing to release. It is no longer listed.`;
}

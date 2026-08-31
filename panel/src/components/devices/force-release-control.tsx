import { ForceReleaseDialog } from '@panel/components/devices/force-release-dialog.js';
import type { ListedDevice } from '@panel/devices/device-list.js';
import { type ForceReleaseAnswer, forceReleaseDevice } from '@panel/devices/force-release.js';
import { useSession } from '@panel/session/session-provider.js';
import { useRef, useState } from 'react';

/**
 * The panel's one operator control: end the lease on this device, after asking.
 *
 * **Recessive**, and inside the lease panel below `GRANTED` — under the data it acts on, so what it
 * would end is read before it is reached. `Profile`'s sign-out is the treatment it follows, for the
 * reason `docs/DESIGN.md` §7 records about the confirmation itself: a control that ends something
 * is not the loudest thing on its screen. The design's own markup turns it red on hover; §5 has no
 * red device state and nothing here has gone wrong, so it warms to
 * `secondary-fixed-dim` exactly as the sign-out does.
 *
 * **Only ever on a held card.** A free device has no lease to end and an `unauthorized` one has
 * none either; the card renders this inside `LeasePanel` and nowhere else, so there is no state to
 * check here — there is no branch for a control that cannot exist.
 *
 * What it does *not* own is the reporting. The card is about to change or disappear underneath the
 * answer, so a settled outcome goes up to the screen through {@link ForceReleaseControl.onSettled}
 * and is said above the grid, where it survives the card it was about (§7). The one answer that
 * stays here is the request that reached nothing: nothing was released, so the dialog stays open
 * with the control usable again.
 */
export function ForceReleaseControl({
	device,
	lease,
	receivedAtMs,
	onSettled,
}: {
	readonly device: ListedDevice;
	readonly lease: NonNullable<ListedDevice['heldBy']>;
	/** When the answer this card renders arrived, which the dialog's countdown shares. */
	readonly receivedAtMs: number;
	/**
	 * The host answered, one way or the other. Never called for a request that reached nothing —
	 * that one has not settled anything, and the panel may not report an ending it did not get (§8).
	 */
	readonly onSettled: (answer: ForceReleaseAnswer, device: ListedDevice) => void;
}) {
	const { state, call } = useSession();
	const [asking, setAsking] = useState(false);
	const [ending, setEnding] = useState(false);
	const [unanswered, setUnanswered] = useState(false);
	const controlRef = useRef<HTMLButtonElement>(null);

	// The router only exists inside a live session (`app.tsx`), so this narrows a type rather than
	// describing a state anybody can reach — and it is the identity the call is attributed with.
	if (state.status !== 'signed-in') {
		return null;
	}
	const actor = state.identity.identifier;

	const open = (): void => {
		setUnanswered(false);
		setAsking(true);
	};

	/*
	 * Cancelling returns focus to the control it came from — the dialog moved focus in, so
	 * something has to move it back, and the element it belongs on is this one.
	 *
	 * A *settled* outcome deliberately does not: this control is inside the lease panel, so it is
	 * unmounted by the very answer it just received. The outcome is announced above the grid in a
	 * polite live region instead, which is the thing that still exists to be read.
	 */
	const cancel = (): void => {
		setAsking(false);
		controlRef.current?.focus();
	};

	const confirm = (): void => {
		setEnding(true);
		setUnanswered(false);
		void (async () => {
			const answer = await forceReleaseDevice(call, { serial: device.serial, actor });
			if (answer.outcome === 'unanswered') {
				// Nothing was released, so nothing closes and nothing is claimed. The control comes
				// back so the same ask can be made again.
				setEnding(false);
				setUnanswered(true);
				return;
			}
			if (answer.outcome === 'access-ended') {
				// `Session.call` has already fired the bounce and the router is coming down. Saying
				// anything here would make the panel's last word the wrong one — the poll leaves the
				// same silence for the same reason.
				return;
			}
			setEnding(false);
			setAsking(false);
			onSettled(answer, device);
		})();
	};

	return (
		<>
			<button
				className="mt-3 w-full rounded-sm border border-outline-variant bg-surface-bright px-4 py-2 font-label-caps text-label-caps text-on-surface-variant uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim"
				onClick={open}
				ref={controlRef}
				type="button"
			>
				Force release
			</button>
			{asking ? (
				<ForceReleaseDialog
					device={device}
					ending={ending}
					lease={lease}
					onCancel={cancel}
					onConfirm={confirm}
					receivedAtMs={receivedAtMs}
					unanswered={unanswered}
				/>
			) : null}
		</>
	);
}

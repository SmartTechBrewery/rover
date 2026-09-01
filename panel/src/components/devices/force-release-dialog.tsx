import { LeaseCountdown } from '@panel/components/devices/lease-countdown.js';
import type { ListedDevice } from '@panel/devices/device-list.js';
import { Gavel, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';

/**
 * The asking, exactly to the settled design — Stitch screen
 * `d86e794af4de4639979bc65104e2ec57` and `docs/DESIGN.md` §7.
 *
 * **A modal over the working panel, which keeps the shell** (§7): the rest of the panel still works
 * and the poll behind this dialog keeps running, so this is not a page and does not rebuild the
 * navigation. That is also why the countdown here is *phase 1's* component reading the same
 * `expiresInMs` and `receivedAtMs` the card reads — the number in the dialog and the number on the
 * card cannot disagree, because there is only one of them.
 *
 * Three things the design settles that a first pass gets wrong, recorded in §7 so they are not
 * "fixed" back:
 *
 * - **`Cancel` is the filled, prominent control and `Force Release` is the recessive one.** The safe
 *   exit is the easier target. Promoting the destructive action to primary is the specific mistake
 *   this arrangement exists to prevent.
 * - **The header is `secondary-container`, not red.** Analog Horizon defines that colour for
 *   critical alerts and physical power metaphors, which is the weight this needs; leaving red unused
 *   keeps it meaningful if something ever genuinely needs it (§5). The emitted markup's
 *   `hover:text-error` on the card's control went the same way.
 * - **`TIME TO AUTO RELEASE`, not "remaining time"**, and never `00:00`. The number answers the
 *   comparison the operator is actually making — am I shortcutting twelve minutes, or four seconds?
 *   It is not a fixed deadline either: expiry is pushed forward by activity (D8), so it is the time
 *   until the lease would end *if nothing else happens*, and it is not dressed as urgent.
 *
 * It says in plain words what confirming does — the lease ends immediately, the device is restored
 * to a clean state, and the agent holding it fails on its next request. That is not softened.
 */
export function ForceReleaseDialog({
	device,
	lease,
	receivedAtMs,
	ending,
	unanswered,
	onCancel,
	onConfirm,
}: {
	readonly device: ListedDevice;
	readonly lease: NonNullable<ListedDevice['heldBy']>;
	/** When the answer this dialog was opened over arrived — the countdown's base. */
	readonly receivedAtMs: number;
	/** A confirmed release is in flight: the control is disabled and says so (§5, no spinner). */
	readonly ending: boolean;
	/** The last ask reached nothing, so nothing was released and this dialog stays open. */
	readonly unanswered: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);

	/*
	 * Focus moves into the dialog on open, and onto `Cancel` rather than onto the destructive
	 * control: the safe exit is the easier target with a keyboard too, not only with a mouse.
	 * Returning it to the control that opened this is the caller's half — it owns that element.
	 */
	useEffect(() => {
		cancelRef.current?.focus();
	}, []);

	/*
	 * Escape cancels, and it is a listener on the document rather than on the dialog so it works
	 * wherever focus has since gone. `keydown` and not `keyup`: a key that opens something on the
	 * way down must not close it on the way up.
	 *
	 * Deliberately **no focus trap**. `aria-modal` tells assistive technology this is modal, and
	 * tabbing past it reaches a panel that genuinely still works (§7) — a trap here would be
	 * machinery defending a claim this design does not make. The backdrop is not a control either:
	 * a stray click outside a destructive confirmation should do nothing at all.
	 */
	useEffect(() => {
		const onKey = (event: KeyboardEvent): void => {
			if (event.key === 'Escape') {
				onCancel();
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [onCancel]);

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-container-lowest/80 p-4">
			<div
				aria-labelledby="force-release-title"
				aria-modal="true"
				className="flex w-full max-w-2xl flex-col overflow-hidden rounded-lg border-2 border-outline-variant bg-surface"
				role="dialog"
			>
				<header className="flex items-center justify-between gap-3 border-outline-variant border-b-2 bg-secondary-container/20 p-4">
					<span className="flex items-center gap-3 text-secondary-container">
						<TriangleAlert aria-hidden="true" size={20} strokeWidth={2} />
						<h2 className="font-headline-sm text-headline-sm uppercase" id="force-release-title">
							Confirm force release
						</h2>
					</span>
					{/*
					 * The design's third way out, and it does exactly what `Cancel` does — closing this
					 * dialog is cancelling, since nothing has been asked of the host yet. Labelled
					 * `Close` rather than `Cancel` so the two are not one accessible name on two
					 * controls, which is ambiguous to anything driving this by name.
					 */}
					<button
						aria-label="Close"
						className="text-on-surface-variant transition-colors hover:text-secondary-container"
						onClick={onCancel}
						type="button"
					>
						<X aria-hidden="true" size={20} strokeWidth={2} />
					</button>
				</header>

				<div className="flex flex-col gap-6 p-6">
					{/*
					 * What is about to end, so the operator recognises the run without going back to
					 * look (§7). `Device` and `Serial` are two fields and not the design's
					 * `Pixel 8 (emulator-5554)`: the serial is the device's identity, it is the
					 * longest string here, and §6 forbids clipping or folding it away.
					 */}
					<dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-sm border-2 border-outline-variant bg-surface-container-low p-4">
						<Field label="Device" value={device.model ?? device.serial} />
						<Field label="Serial" value={device.serial} />
						<Field label="Owner" value={lease.owner} />
						<Field label="Project" value={lease.project} />
						{/*
						 * Never shortened to `TEST` (§2, §7). Always present, as on the card: a lease
						 * cannot be taken without a test name (D22, as amended #129).
						 */}
						<Field className="col-span-2" label="Test name" value={lease.testName} />
						<Field
							className="col-span-2"
							label="Time to auto release"
							value={<LeaseCountdown expiresInMs={lease.expiresInMs} receivedAtMs={receivedAtMs} />}
						/>
					</dl>

					<div className="flex items-start gap-4 border-secondary-container border-l-4 bg-secondary-container/10 p-4">
						<Gavel
							aria-hidden="true"
							className="mt-0.5 shrink-0 text-secondary-container"
							size={20}
							strokeWidth={2}
						/>
						<p className="font-body-md text-body-md text-on-surface-variant">
							This ends the lease <strong className="text-on-surface">immediately</strong>. The
							device is restored to a clean state, and the agent holding the lease fails on its next
							request.
						</p>
					</div>

					{/*
					 * The request that reached nothing — not an outcome, and the one answer that leaves
					 * this dialog open with the control usable again. §8's rule holds unchanged: the
					 * panel never reports an ending it did not get, so this says what did not happen
					 * and where the panel is going instead. It does not say "try again" over a host
					 * the poll is about to replace this whole page for, and it carries no colour of
					 * alarm — nothing is wrong with the lease, which is exactly still there.
					 */}
					<p aria-live="polite" className="font-body-md text-body-md text-on-surface">
						{unanswered
							? 'Nothing came back from the host, so nothing was released and that lease is still open. Ask again — and if the host stays unreachable the panel says so in place of this page.'
							: ''}
					</p>
				</div>

				<footer className="flex items-center justify-end gap-4 border-outline-variant border-t-2 bg-surface-container-low p-4">
					{/*
					 * Recessive, and disabled with a changed label while the ask is out — `Profile`'s
					 * sign-out treatment, which is §5's pending state and never a spinner.
					 */}
					<button
						className={
							ending
								? 'cursor-not-allowed rounded-sm border-2 border-outline-variant px-6 py-3 font-label-caps text-label-caps text-on-surface-variant uppercase'
								: 'rounded-sm border-2 border-outline px-6 py-3 font-label-caps text-label-caps text-on-surface uppercase transition-colors hover:border-secondary-fixed-dim hover:text-secondary-fixed-dim'
						}
						disabled={ending}
						onClick={onConfirm}
						type="button"
					>
						{ending ? 'Ending…' : 'Force release'}
					</button>
					<button
						className="rounded-sm bg-primary px-8 py-3 font-label-caps text-label-caps text-on-primary uppercase transition-colors hover:bg-primary-fixed"
						onClick={onCancel}
						ref={cancelRef}
						type="button"
					>
						Cancel
					</button>
				</footer>
			</div>
		</div>
	);
}

/** The card's own anatomy, in the dialog: a caps label over its value in the monospace face (§6). */
function Field({
	label,
	value,
	className,
}: {
	readonly label: string;
	readonly value: ReactNode;
	readonly className?: string;
}) {
	return (
		<div className={className}>
			<dt className="font-label-caps text-label-caps text-on-surface-variant uppercase">{label}</dt>
			<dd className="mt-2 break-words font-code-md text-code-md text-on-surface">{value}</dd>
		</div>
	);
}

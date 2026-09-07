import type { ArchivedArtifactState } from '@panel/archive/artifact.js';
import { ArtifactBodyView, OpenInANewWindow } from './artifact-body-view.js';
import { CardHeading, ContentsCard } from './contents-card.js';

/**
 * One artifact, read where it was found — the Archive screen's card beside the tree while a file is
 * open (#133, #160; `docs/DESIGN.md` §9; Stitch `a843d32b7a414ac3a84fd7e80aa8a8bf`, deliberately
 * departed from in that the preview stands beside the **tree** rather than beside the run's column).
 *
 * **The four states, the four bodies, the clean region and the one control are
 * `artifact-body-view.tsx`'s** since #199, where a second card came to need them: the groups view's
 * comparison card draws N artifacts side by side, and *how* an artifact is drawn may not differ
 * between the two. That was an extraction and not a rewrite — the DOM this card renders is
 * unchanged, and every rule that was written here about the body is written there now.
 *
 * **This card is what an artifact selected in the `All` view draws, at every depth, and it is what
 * the groups view draws for an artifact that has nothing to compare with** — no label, or a label
 * only one run in its group filed (#199, `comparisonAt`). One pane is not a comparison, so an
 * archive that never used labels sees exactly this card everywhere it always did.
 *
 * **Three bodies share one frame** (`ContentsCard`), and only what sits inside it differs. The
 * fourth, `opaque`, is the honest answer for bytes the host could not name.
 *
 * **One control, and it is a view rather than a transfer.** `Open in a new window` opens the object
 * URL the hook already holds — no second fetch, no `window.open`, and **no `download` attribute
 * anywhere**. There is no download control in the panel at all (§10): Rover is the machine holding
 * the artifact and the archive is browsable there already (D4).
 *
 * **What is deliberately not here**, all of it from the issue's binding rules: no zoom, pan or
 * rotate; no filmstrip and no next/previous arrows, because the tree is how another file is chosen
 * (#160); no annotation, measurement or comparison tooling — and **that last one is unchanged by
 * #199**: standing labelled artifacts side by side is a card of its own, and nothing about it is a
 * control on this one.
 *
 * **The artifact's height bound is `ARTIFACT_MAX_HEIGHT`, and it is viewport-relative because a
 * percentage one does not resolve here** (#140 review). Nothing above the artifact has a definite
 * height — the card's `<section>` is `min-h-[400px]` with `height: auto`, and its body is a `flex-1`
 * item that stretches to whatever is in it — so a `max-height: 100%` computes to `none` while
 * `max-width: 100%` resolves normally. Measured in headless Chrome at 1400x900 on the built card
 * chain: a 1080x2400 screenshot under `max-h-full` came out **576x1278** with the card 1372 px tall
 * and its `overflow-y-auto` body never scrolling; under `max-h-[70vh]` it comes out **257x569** with
 * the card 663 px. §9 records it.
 */
export function ArtifactPreview({
	path,
	artifact,
}: {
	/** The open artifact's address — the components a listing answered, verbatim. */
	readonly path: readonly string[];
	readonly artifact: ArchivedArtifactState;
}) {
	const name = path.at(-1) ?? '';
	return (
		<ContentsCard
			header={
				<div className="flex items-center justify-between gap-4">
					<CardHeading>{name}</CardHeading>
					{artifact.status === 'read' ? <OpenInANewWindow body={artifact.body} /> : null}
				</div>
			}
		>
			<ArtifactBodyView artifact={artifact} name={name} />
		</ContentsCard>
	);
}

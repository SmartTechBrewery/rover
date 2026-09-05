import type { ArchivedArtifactState, ArtifactBody } from '@panel/archive/artifact.js';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { CardHeading, ContentsCard } from './contents-card.js';

/**
 * One artifact, read where it was found — the Archive screen's card beside the tree while a file is
 * open (#133, #160; `docs/DESIGN.md` §9; Stitch `a843d32b7a414ac3a84fd7e80aa8a8bf`, deliberately
 * departed from in that the preview stands beside the **tree** rather than beside the run's column).
 *
 * **The region around the artifact is clean, and that is the rule that is not traded away.** Nothing
 * is laid over or around it: no scanline, no dotted pattern, no gradient, no tint, no
 * `mix-blend-mode`, no vignette, no glow, no phone frame or device bezel, no drop shadow, no
 * coloured frame, no watermark. A hairline border is the most that is permitted, and it is on the
 * image alone. §5 wrote that rule before there was a screen to apply it to — *an overlay tints the
 * exact thing the user opened the screen to look at* — and this is where it is cashed in;
 * `artifact-preview.test.tsx` asserts the region's class list carries none of them.
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
 * (#160); no annotation, measurement or comparison tooling, because comparison is a different
 * screen's question.
 *
 * **The artifact's height bound is {@link ARTIFACT_MAX_HEIGHT}, and it is viewport-relative because
 * a percentage one does not resolve here** (#140 review). Nothing above the artifact has a definite
 * height — the card's `<section>` is `min-h-[400px]` with `height: auto`, and its body is a `flex-1`
 * item that stretches to whatever is in it — so a `max-height: 100%` computes to `none` while
 * `max-width: 100%` resolves normally. Measured in headless Chrome at 1400x900 on the built card
 * chain: a 1080x2400 screenshot under `max-h-full` came out **576x1278** with the card 1372 px tall
 * and its `overflow-y-auto` body never scrolling; under `max-h-[70vh]` it comes out **257x569** with
 * the card 663 px. §9 records it.
 */
/**
 * What bounds an artifact's height, and it is one class in one place because three bodies share it.
 *
 * **Viewport-relative rather than a percentage**, for the reason this module's header measures: the
 * card chain has no definite height, so `max-h-full` is inert and the artifact is bounded by width
 * alone — which grew the whole screen to the height of one portrait screenshot and stretched the run
 * column blank beside it. `70vh` leaves the header, the breadcrumb and the card's own strip visible
 * above it at the window heights the shell is built for.
 *
 * Written out rather than composed, because Tailwind reads these class names out of the source text.
 */
const ARTIFACT_MAX_HEIGHT = 'max-h-[70vh]';

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
			<Body artifact={artifact} name={name} />
		</ContentsCard>
	);
}

/**
 * The design's own recessive control, and it renders for the three bodies a browser would display.
 *
 * **Absent for `opaque`**, where there is nothing to display: offering it would be offering a
 * download, which §10 forbids outright — and §3's rule already says a control that does nothing is
 * worse than none.
 *
 * `rel="noopener noreferrer"` on a `target="_blank"` because the opened document must not reach back
 * into this one; the address is a `blob:` URL of this tab's own bytes, which is exactly why the tab
 * needs no credential and why the plain `/artifact/…` address is not what is opened here (D20, and
 * `panel/src/session/host-client.ts` for why a subresource cannot carry one).
 */
function OpenInANewWindow({ body }: { readonly body: ArtifactBody }) {
	if (body.kind === 'opaque') {
		return null;
	}
	return (
		<a
			className="flex shrink-0 items-center gap-2 rounded-sm border-2 border-outline-variant bg-surface px-3 py-1.5 text-on-surface-variant transition-colors hover:border-tertiary hover:text-tertiary"
			href={body.url}
			rel="noopener noreferrer"
			target="_blank"
		>
			<ExternalLink aria-hidden="true" size={16} strokeWidth={2} />
			<span className="font-code-md text-[12px]">Open in a new window</span>
		</a>
	);
}

/**
 * The four states, and the three that are not an artifact read differently from one another.
 *
 * *Nothing is filed at this address* and *the host will not read what is* are the pair that must
 * never render alike (D6), one file down from the archive's own empty/unreadable levels. Neither is
 * an alarm: no colour, no icon, no error code and no retry control (§7).
 */
function Body({
	artifact,
	name,
}: {
	readonly artifact: ArchivedArtifactState;
	readonly name: string;
}) {
	if (artifact.status === 'reading') {
		return (
			<Plain>
				<p aria-live="polite" className="font-code-md text-code-md text-on-surface-variant">
					Reading this artifact.
				</p>
			</Plain>
		);
	}
	if (artifact.status === 'missing') {
		return (
			<Plain>
				<p className="font-code-md text-code-md text-on-surface-variant">
					Nothing is filed at this address. Rover writes a file only when a verb produces bytes, so
					this is an ordinary answer rather than a fault.
				</p>
			</Plain>
		);
	}
	if (artifact.status === 'unreadable') {
		return (
			<Plain>
				<p className="font-code-md text-code-md text-on-surface-variant">
					Rover cannot read this artifact. Something is there and the host will not serve it, which
					is a different answer from nothing being there at all.
				</p>
			</Plain>
		);
	}

	const body = artifact.body;
	if (body.kind === 'image') {
		return (
			/*
			 * Contained, centred, at its natural aspect ratio — **never stretched and never cropped**.
			 * `max-*` caps it and **no dimension is set at all**, which is what keeps a small screenshot
			 * at its own pixels: an enlarged screenshot is a blurrier version of the evidence somebody
			 * opened it to read (§10). The hairline border is the whole of what is laid around it.
			 */
			<Region>
				<img
					alt={name}
					className={`block ${ARTIFACT_MAX_HEIGHT} max-w-full border border-outline-variant object-contain`}
					src={body.url}
				/>
			</Region>
		);
	}
	if (body.kind === 'recording') {
		return (
			<Region>
				{/*
				 * The browser's own controls, which already have a scrub bar, a keyboard and a volume —
				 * a styled player would be a second video UI to maintain for no gain (§10). **No
				 * `autoPlay` and no `loop`**: §5 forbids anything that loops on its own, and a video a
				 * person pressed play on is a response to something real.
				 *
				 * biome-ignore lint/a11y/useMediaCaption: an archived recording has no caption track and
				 * Rover has none to write. An empty `<track>` would claim captions this file does not
				 * carry, which is worse for a screen reader than the honest absence.
				 */}
				<video className={`${ARTIFACT_MAX_HEIGHT} max-w-full`} controls src={body.url} />
			</Region>
		);
	}
	if (body.kind === 'text') {
		return <Lines lines={body.lines} />;
	}
	/*
	 * The host served bytes it could not name (`application/octet-stream`). Said in
	 * `NothingFiledHere`'s language and weight: no alarm colour, no icon, no error code and no
	 * control — the file is filed, and this panel simply has no way to draw it.
	 */
	return (
		<Plain>
			<p className="font-code-md text-code-md text-on-surface-variant">
				This panel has no way to show this file. Rover filed it exactly as it was written, and the
				host holding it is where it can be opened.
			</p>
		</Plain>
	);
}

/**
 * The clean region the artifact sits in.
 *
 * `bg-surface` and centring, and **nothing else** — see this module's header for the list of what
 * may not be added here. `min-h-full` so a small screenshot is centred in the whole column rather
 * than pinned to its top.
 */
function Region({ children }: { readonly children: ReactNode }) {
	return (
		<div className="flex min-h-full items-center justify-center bg-surface p-6">{children}</div>
	);
}

/** One sentence where the artifact would be, on the card's own surface. */
function Plain({ children }: { readonly children: ReactNode }) {
	return <div className="px-6 py-5">{children}</div>;
}

/**
 * A text file, printed verbatim in the monospace face with a line-number gutter — **because those
 * are the file's real lines** (`artifact-body.ts`, `linesOf`).
 *
 * **The level is plain text with no colour.** Nothing is parsed out of a line: `W` and `E` are the
 * device's own words about its own logs, not Rover's verdict on anything, and colouring them imports
 * the pass/fail vocabulary §2 has already had to remove several times — on the one region of the
 * panel where a fabricated `PASS` line lived longest.
 *
 * The line wraps rather than being truncated, and the gutter stays aligned with the **first** row of
 * a wrapped line, which is what `items-start` on the row buys.
 *
 * **The lines scroll inside the card rather than growing it**, under the same
 * {@link ARTIFACT_MAX_HEIGHT} the image and the recording take (#140 review). The card's own
 * `overflow-y-auto` body cannot do it — it has no definite height to overflow — so a 5 000-line log
 * (`MAX_LOG_ENTRIES`) made the page tens of thousands of pixels tall and page-scrolled the run
 * column away beside it. Measured: 569 px tall over a 150 048 px `scrollHeight`, card 614 px.
 */
function Lines({ lines }: { readonly lines: readonly string[] }) {
	return (
		<div className={`min-h-full ${ARTIFACT_MAX_HEIGHT} overflow-y-auto bg-surface p-6`}>
			<ol className="font-code-md text-[13px] text-on-surface-variant">
				{lines.map((line, index) => (
					/*
					 * biome-ignore lint/suspicious/noArrayIndexKey: the index **is** the identity here. A
					 * file's lines never reorder and two of them may legitimately be the same text, so the
					 * line number is the only key that identifies one — and it is what the gutter prints.
					 */
					<li className="flex items-start gap-4" key={index}>
						<span className="w-10 shrink-0 select-none text-right text-outline">{index + 1}</span>
						<span className="min-w-0 whitespace-pre-wrap break-words">{line}</span>
					</li>
				))}
			</ol>
		</div>
	);
}

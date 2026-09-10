import type { ArchivedArtifactState, ArtifactBody } from '@panel/archive/artifact.js';
import type { ImageMarks } from '@panel/archive/marked-differences.js';
import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { DifferenceMarks } from './difference-marks.js';

/**
 * **What one artifact's bytes look like on this screen, and the one control over them** — extracted
 * verbatim out of `artifact-preview.tsx` when a second card came to need it (#199).
 *
 * Two cards draw an artifact now: the single preview beside the tree (#133, #160) and the groups
 * view's comparison card, which draws N of them side by side. What must not differ between them is
 * *how* a body is drawn — the four states, the four bodies, the clean region, the height bound and
 * `opaque` creating no object URL — so it lives here rather than being copied. §9's *three bodies
 * share one frame* and *there is not a second extension table in the panel* are exactly the rules a
 * second copy of this switch would break: a labelled recording drawn differently from an unlabelled
 * one is the failure, and it would not look like one until somebody labelled a recording.
 *
 * **The rendered DOM is the one the preview always rendered.** This was a move, not a rewrite: the
 * region around the artifact carries the same classes, in the same nesting, so
 * `artifact-preview.test.tsx`'s region selector and its clean-region assertions hold untouched.
 *
 * **The region around the artifact is clean, and that stays the rule.** Nothing is laid over or
 * around it: no scanline, no dotted pattern, no gradient, no tint, no `mix-blend-mode`, no vignette,
 * no glow, no phone frame or device bezel, no drop shadow, no coloured frame, no watermark. A
 * hairline border is the most that is permitted, and it is on the image alone. §5 wrote that rule
 * before there was a screen to apply it to — *an overlay tints the exact thing the user opened the
 * screen to look at* — and this is where it is cashed in.
 *
 * **{@link ArtifactBodyView.marks} is the one exception, and it is narrow on purpose**: the
 * comparison card's difference boxes, over the second image of a pair, **only** once the reader has
 * asked for them. Every item on the list above is decoration that costs contrast and returns
 * nothing; the marks are an answer to a question somebody pressed a control to ask, they are absent
 * until then, and `difference-marks.tsx` is where the distinction is argued out. Nothing else may
 * be added here on that precedent.
 *
 * **Which body a file gets comes from the host's own content type** (`artifact-body.ts`,
 * `src/daemon/archive-file.ts`), so a labelled recording and a labelled `read_logs` compare the way
 * a screenshot does, and there is no second extension table anywhere in the panel.
 */

/**
 * What bounds an artifact's height, and it is one class in one place because three bodies share it
 * — **and two cards do now** (#199), which is why it is exported.
 *
 * **Viewport-relative rather than a percentage**, for the reason `artifact-preview.tsx`'s header
 * measures: the card chain has no definite height, so `max-h-full` is inert and the artifact is
 * bounded by width alone — which grew the whole screen to the height of one portrait screenshot and
 * stretched the run column blank beside it. `70vh` leaves the header, the breadcrumb and the card's
 * own strip visible above it at the window heights the shell is built for.
 *
 * Written out rather than composed, because Tailwind reads these class names out of the source text.
 */
export const ARTIFACT_MAX_HEIGHT = 'max-h-[70vh]';

/** What the control is called, in every channel — the visible text, the `title` and the label. */
const OPEN_IN_A_NEW_WINDOW = 'Open in a new window';

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
 *
 * **`iconOnly` is a comparison pane's shape and nothing else**, a correction to #199 made in place.
 * A pane is floored at 240px and there are N of them in one row, so the glyph and its four words is
 * the widest thing in a head that now holds only a badge beside it; the single preview beside the
 * tree has a whole card's width for its strip and keeps the words. **The name does not change with
 * the shape** — it moves out of the text and into `aria-label` and `title`, so the control is the
 * same control to a screen reader, to a pointer resting on it, and to a test that finds it by name.
 */
export function OpenInANewWindow({
	body,
	iconOnly = false,
}: {
	readonly body: ArtifactBody;
	/** Drop the words and keep the glyph — the comparison pane's head, never the preview's strip. */
	readonly iconOnly?: boolean;
}) {
	if (body.kind === 'opaque') {
		return null;
	}
	return (
		<a
			aria-label={iconOnly ? OPEN_IN_A_NEW_WINDOW : undefined}
			className={`flex shrink-0 items-center gap-2 rounded-sm border-2 border-outline-variant bg-surface text-on-surface-variant transition-colors hover:border-tertiary hover:text-tertiary ${iconOnly ? 'p-1.5' : 'px-3 py-1.5'}`}
			href={body.url}
			rel="noopener noreferrer"
			target="_blank"
			title={OPEN_IN_A_NEW_WINDOW}
		>
			<ExternalLink aria-hidden="true" size={16} strokeWidth={2} />
			{iconOnly ? null : <span className="font-code-md text-[12px]">{OPEN_IN_A_NEW_WINDOW}</span>}
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
export function ArtifactBodyView({
	artifact,
	name,
	marks = null,
}: {
	readonly artifact: ArchivedArtifactState;
	readonly name: string;
	/**
	 * The comparison card's difference boxes, for an **image** body and nothing else — `null`
	 * everywhere else in the panel, which is every caller but one and the state the single preview is
	 * always in.
	 *
	 * `null` renders the DOM this component has always rendered, down to the class list, which is
	 * what keeps the clean-region assertions in `artifact-preview.test.tsx` about the region they
	 * were written for.
	 */
	readonly marks?: ImageMarks | null;
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
		/*
		 * Contained, horizontally centred, at its natural aspect ratio — **never stretched and never
		 * cropped**. `max-*` caps it and **no dimension is set at all**, which is what keeps a small
		 * screenshot at its own pixels: an enlarged screenshot is a blurrier version of the evidence
		 * somebody opened it to read (§10). The hairline border is the whole of what is laid around it.
		 */
		const image = (
			<img
				alt={name}
				className={`block ${ARTIFACT_MAX_HEIGHT} max-w-full border border-outline-variant object-contain`}
				src={body.url}
			/>
		);
		return (
			<Region>
				{marks === null ? image : <DifferenceMarks marks={marks}>{image}</DifferenceMarks>}
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
 * `bg-surface` and horizontal centring, and **nothing else** — see this module's header for the
 * list of what may not be added here.
 *
 * ***`min-h-full` so a small screenshot is centred in the whole column rather than pinned to its
 * top* is reversed on the vertical axis** (#279, edited in place with its reason rewritten rather
 * than deleted). That held while the card was roughly the artifact's own size — a small screenshot
 * in a 400px card reads better centred than pinned to the top. It stopped holding when #160 put the
 * tree beside the preview and the row became `xl:items-stretch` (`routes/archive.tsx`, `Columns`):
 * the card is then as tall as the *tree*, which with several branches expanded is several thousand
 * pixels, so the midpoint of the region is below the fold and opening a screenshot cost a scroll to
 * find the thing that was just opened. `items-start` puts the artifact where the reader is already
 * looking, and `p-6` is what keeps top-aligned from meaning flush against the card's border.
 *
 * **Only the vertical axis changed.** `justify-center` still centres the artifact horizontally,
 * `min-h-full` stays because it is what keeps `bg-surface` covering the card's whole body rather
 * than ending under the artifact, and {@link ARTIFACT_MAX_HEIGHT} still bounds it — this is where
 * the artifact sits, not how big it is.
 */
function Region({ children }: { readonly children: ReactNode }) {
	return (
		<div className="flex min-h-full items-start justify-center bg-surface p-6">{children}</div>
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
 * panel where a fabricated verdict line lived longest.
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

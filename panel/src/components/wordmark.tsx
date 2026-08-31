/**
 * The product's identity, and the only place the chromatic offset is written.
 *
 * Two screens carry the wordmark — the shell's sidebar and the shell-less sign-in page — and
 * `docs/DESIGN.md` §5 puts the chroma on the wordmark and on nothing else: serials, timestamps and
 * hashes stay crisp. One component is how that stays true by construction rather than by two class
 * lists agreeing, and it is what
 * `tests/unit/panel/tokens-are-the-source-of-truth.test.ts` asserts.
 *
 * No layout of its own. The sidebar puts it in a bordered block and the sign-in card centres it;
 * neither belongs to the mark.
 */
export function Wordmark() {
	return (
		<span className="wordmark-chroma block font-display-lg text-display-lg text-secondary">
			ROVER_OS
		</span>
	);
}

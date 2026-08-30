/**
 * Parser for the confirmation line `uiautomator dump` prints about itself.
 *
 * Its sibling `./hierarchy.ts` owns the document; this owns the one line of the *command*
 * that wrote it. The split matters because the two arrive over different calls — the dump
 * writes a file on the device and says so, and a second `adb exec-out cat` fetches it —
 * and the line is the only thing connecting them.
 *
 * **Why the line is read at all.** The dump path is a fixed literal
 * (`/sdcard/window_dump.xml`, PROJECT.md §6), so it can already hold the file a previous
 * read left there. A dump that did not produce a hierarchy, followed by a `cat` that
 * happily succeeds, hands the agent a screen from a minute ago — indistinguishable from
 * the current one, and acted on. Checking that the command names *the path this call
 * asked for* is what rules that out.
 *
 * **What it is not.** Measured on API 37 / adb 37.0.0 (2026-08-30): `uiautomator dump
 * /data/nope/window_dump.xml` prints the same confirmation, naming that path, and exits 0
 * while writing nothing — the capture is
 * `tests/fixtures/adb/uiautomator-dump.unwritable-path.…txt`. So the line is a *claim*
 * about a path, not proof a file exists at it. That is enough for the caller's question,
 * because the caller's path is one it owns and knows to be writable, and the `cat` that
 * follows fails loudly on a file that is not there. It is not enough to be read as "the
 * dump succeeded", which is why this function answers a path rather than a boolean.
 *
 * Pinned to a capture like every predicate in this folder, and for the sharper reason
 * `saysSuccess`/`startedActivity` are: adb prints real output on whichever stream it likes
 * (PROJECT.md §6), so the fixture was taken with `> f 2>&1` and the *stream* recorded
 * rather than assumed. It is stdout, and stderr was empty.
 */

/**
 * The wording, typo and all.
 *
 * `hierchary` is uiautomator's own misspelling of "hierarchy" and has been in the platform
 * for a decade — matched as captured rather than as it ought to read, because this module
 * asserts what the device says and not what it should have said. Anchored to the start of
 * a line so the label cannot be matched inside a path or inside somebody's `content-desc`
 * echoed back by an unrelated command; the tail is taken to the end of the line, because a
 * path may contain spaces.
 */
const DUMPED_LINE = /^UI hierchary dumped to:[ \t]*(\S.*?)[ \t]*$/;

/**
 * The path `uiautomator dump` reported it wrote, or `null` when it reported none.
 *
 * `null` for every shape that is not the line — an empty output, an error, a dump that
 * printed something new on a newer API. A miss is not an error here (ai/CODING_STANDARDS.md
 * "Error handling"): the caller is the one that knows which device and which path it asked
 * about, and it is the one that can say so.
 *
 * `\r` is trimmed for the reason `./app-control.ts`'s `outputLines` gives — nothing on an
 * API 37 emulator over the v2 shell protocol carries one, but a pty-backed shell ends
 * every line `\r\n`, and an equality test against a path is exactly the assertion that
 * would then silently stop matching.
 *
 * The **last** match wins when there is more than one. adb's own client chatter can
 * precede the command's output, and nothing can follow the line the command ends with; a
 * first-match rule would be the one that could be talked over.
 */
export function dumpedPath(output: string): string | null {
	let path: string | null = null;

	for (const line of output.split('\n')) {
		const match = DUMPED_LINE.exec(line.replace(/\r+$/, ''));
		if (match) path = match[1];
	}

	return path;
}

/**
 * The refusals of `run-as <package> …` — what the device says when it will not enter an
 * application's data container for this host (#334).
 *
 * `run-as` runs a command **as the application**, in its data directory — measured on API 37
 * (PROJECT.md §6), `pwd` under it prints `/data/user/0/<package>` — and that is the only route
 * from a shell user to an app's private files. It opens that route only for some packages, and
 * says why not on **stderr** with exit **1** over `adb shell`. Over `adb exec-out` the same line
 * arrives on **stdout** with exit **0**, which is why `pullAppFile` asks with `shell` first and
 * reads with `exec-out` only once that probe has answered.
 *
 * Pinned to captures — `tests/fixtures/adb/run-as.*.stderr.*` — because which packages it
 * refuses, and how it words each refusal, is the thing that would otherwise be written from
 * memory:
 *
 * - **`package not debuggable`** — an installed third-party app whose build is not debuggable.
 *   The release build of every app an agent debugs, which is what makes this the refusal that
 *   matters.
 * - **`unknown package`** — nothing by that name is installed.
 * - **`package not an application`** — a package that runs as a system user, not as an app
 *   (`com.android.settings` on API 37), so it has no app uid for `run-as` to become.
 *
 * Anything else is `null`: a wording no capture here has is quoted by the caller rather than
 * guessed into one of these.
 */

/** Which of the three captured refusals `run-as` gave. */
export type RunAsRefusal = 'not-debuggable' | 'unknown-package' | 'not-an-application';

/**
 * One refusal line, anchored at a line start so a file whose *content* happens to say the same
 * words is not mistaken for one — the caller only ever hands this a stream `run-as` wrote
 * instead of the file, but the anchor costs nothing.
 */
const REFUSAL_LINE =
	/^run-as: (package not debuggable|unknown package|package not an application): /m;

const REFUSALS: Readonly<Record<string, RunAsRefusal>> = {
	'package not debuggable': 'not-debuggable',
	'unknown package': 'unknown-package',
	'package not an application': 'not-an-application',
};

/** The refusal `run-as` printed, or `null` when the stream carries none this recognises. */
export function runAsRefusal(stream: string): RunAsRefusal | null {
	const phrase = REFUSAL_LINE.exec(stream)?.[1];
	return phrase === undefined ? null : (REFUSALS[phrase] ?? null);
}

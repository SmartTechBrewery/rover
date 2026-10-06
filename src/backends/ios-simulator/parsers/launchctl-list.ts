/**
 * The parser for `launchctl list` as it is printed **inside** a booted simulator — the one
 * question this backend asks it: which processes is an app running under right now.
 *
 * Pure, and beside the other parsers for `./unified-log.js`'s reason: `../simctl.js` owns the
 * process, `../backend.ts` is the join, and what the tool's output *is* belongs here where it
 * can be pinned against a capture on a machine with no Xcode.
 * `../../android/parsers/app-control.ts`'s `parsePids` is the counterpart — the same question,
 * asked of `pidof` there and of launchd here, because a simulator has no `pidof`.
 *
 * Captured on macOS 27.0.1 (26A434) / Xcode 26.4.1 (17E202) / iOS 26.4.1 (23E254a), 2026-10-06
 * (`tests/fixtures/ios-simulator/launchctl-list.xcode26.4.1-ios26.4.1.txt`): 379 jobs, a header
 * row, and four `UIKitApplication:` labels among them.
 */

/** The header `launchctl list` prints before its first job, dropped like any other framing. */
const HEADER = 'PID\tStatus\tLabel';

/**
 * The prefix launchd gives an application's job, and the one thing that tells an app apart
 * from the three hundred daemons sharing the listing.
 *
 * Measured on the bench above, a full label reads
 * `UIKitApplication:com.apple.Preferences[10ab][rb-legacy]` — the prefix, the bundle id, a
 * four-hex-digit instance tag, and a role the runtime assigns. Both bracketed parts belong to
 * launchd rather than to the app, so the bundle id is what sits **between the colon and the
 * first `[`** and nothing else is matched against.
 */
const APP_LABEL_PREFIX = 'UIKitApplication:';

/** What the PID column holds for a job that is registered but not running. */
const NOT_RUNNING = '-';

/**
 * The pids `appId` is running under, newest listing first — empty when it is not running.
 *
 * **The bundle id is matched whole**, up to the instance tag's `[`, so a read of `com.foo` can
 * never be answered with `com.foo.bar`'s process. That is the same guarantee
 * `../../android/parsers/app-control.ts` gets from `pidof`'s exact process-name match, and it
 * matters more here: a listing is scanned rather than queried, so a prefix match would be
 * silent and would attribute one app's log lines to another.
 *
 * **An app that is not running is empty rather than absent-or-dash**, because launchd spells it
 * both ways and neither is this function's caller's business. A terminated app's job
 * disappeared from the listing entirely on the bench (`simctl terminate` then a fresh listing:
 * four `UIKitApplication:` labels became three), while a registered-but-idle job carries `-` in
 * the PID column — 198 of the 379 jobs in the capture do. Both mean no process.
 *
 * Several pids are possible and are kept in the order launchd listed them: an app with
 * extensions or a relaunched one can hold more than one job at once, which is exactly why the
 * neutral selection takes a list (`src/core/log-filter.ts`, `LogEntrySelection.pids`).
 *
 * A line this cannot read at all — the header, a blank line, a label with no colon — is skipped
 * rather than guessed at. Unlike a *log* line, there is nothing to lose by dropping it: this is
 * a lookup table, not something the device said.
 */
export function parseAppPids(stdout: string, appId: string): number[] {
	const pids: number[] = [];

	for (const line of stdout.split('\n')) {
		if (line.length === 0 || line === HEADER) continue;

		const [pid, , label] = line.split('\t');
		if (pid === undefined || label === undefined) continue;
		if (pid === NOT_RUNNING || !/^\d+$/.test(pid)) continue;
		if (bundleIdOf(label) !== appId) continue;

		pids.push(Number(pid));
	}

	return pids;
}

/**
 * The bundle id a `UIKitApplication:` label names, or `null` for every other job.
 *
 * `indexOf('[')` rather than a regular expression over the whole label, because what follows the
 * bundle id is launchd's and this is not the place to make a claim about its shape — a release
 * that adds a third bracketed part, or drops `[rb-legacy]`, changes nothing here. A label with
 * no `[` at all is taken whole, which is the same reading.
 */
function bundleIdOf(label: string): string | null {
	if (!label.startsWith(APP_LABEL_PREFIX)) return null;

	const rest = label.slice(APP_LABEL_PREFIX.length);
	const tag = rest.indexOf('[');
	return tag === -1 ? rest : rest.slice(0, tag);
}

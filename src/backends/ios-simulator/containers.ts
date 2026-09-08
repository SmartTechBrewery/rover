/**
 * The device-path → host-path mapping the two transfers run on, and the confinement rule that
 * makes it safe.
 *
 * Pure, and its own module for `./screen.ts`'s reason: the rule is then testable with no
 * simulator, no `simctl` and no filesystem layout of the author's own
 * (`tests/unit/backends/ios-simulator/containers.test.ts`).
 *
 * **A simulator's storage *is* a host path, so a transfer here is a file copy.** Not `idb file
 * push`, which crashes its companion deterministically and takes every other in-flight call for
 * that device with it (`docs/IOS.md` §4), and not a `simctl` subcommand either: there is no
 * generic file transfer in the tool at all. Verified against `simctl help` on Xcode 26.4.1,
 * 2026-09-08 — `addmedia`, `get_app_container`, `pbcopy`/`pbpaste`/`pbsync` and
 * `install_app_data` are everything that moves a byte, and each of them moves one particular
 * kind of byte to one particular place.
 *
 * **There is also no in-simulator absolute namespace to relay a path through**, which is what
 * forces the mapping rather than merely permitting it. `simctl spawn`'s filesystem view is the
 * **host's**: measured on the same bench, `simctl spawn <udid> /bin/ls /var` lists this Mac's
 * `/var` — `folders`, `jabberd`, `msgs` — and `/bin/ls /var/mobile` answers *"No such file or
 * directory"*. So a `spawn cat` route would read and write host paths under host names while
 * looking like it addressed the device, and `devicePath` has nowhere to be resolved except
 * under the device's own data root.
 *
 * That root is the `dataPath` of the device's own `simctl list -j devices` entry
 * (`./parsers/simctl-list.js`) — `~/Library/Developer/CoreSimulator/Devices/<udid>/data` on the
 * bench, holding `Containers`, `Documents`, `Downloads`, `Library`, `Media`, `tmp` and `var`.
 * So a `devicePath` of `/Documents/report.bin` is that device's `Documents/report.bin` and
 * nothing else's.
 */

import { isAbsolute, join, resolve, sep } from 'node:path';
import { type DeviceSerial, unwrap } from '../../core/ids.js';

/**
 * The host path `devicePath` names on the device whose data root is `dataRoot`.
 *
 * **The confinement is the load-bearing half.** `DevicePathSchema` (`src/ipc/verb-methods.ts`)
 * requires a leading `/` and forbids NUL and a trailing slash, but it does *not* forbid `..` —
 * it was written for a path a device's own transfer tool would interpret, where the worst a
 * `..` reaches is somewhere else on the device. Here the destination is a real path on the
 * machine lending the device, so an unconfined join is a remote write anywhere this host's user
 * can write: `/../../../../etc/x` joined onto the root leaves it in four segments. Both callers
 * go through here and neither moves a byte before it returns.
 *
 * The check is *lexical* — `path.join` normalises the `..` segments away and the result is
 * required to be under the root — and deliberately does not follow symlinks, which would be
 * both stricter and wrong. CoreSimulator puts one in the data root itself: on the bench
 * `<dataRoot>/Library/Logs` is a symlink to `~/Library/Logs/CoreSimulator/<udid>`, that device's
 * own log directory, outside the root by construction. A `realpath` rule would refuse a
 * perfectly ordinary device path, and it would buy nothing against the case that matters: a
 * symlink under the root is something only code already running on this host could have made,
 * and an app on a simulator is a process on this host. What the rule prevents is a path *the
 * caller composed* naming somewhere the caller was never lent.
 *
 * **A relative `devicePath` is refused rather than resolved**, and the refusal is here rather
 * than left to `DevicePathSchema` so it cannot be skipped by a caller that did not arrive over
 * IPC. `join` accepts one happily: `Documents/x` would land in exactly the same place as
 * `/Documents/x`, which makes the leading slash look optional to whoever tries it and then
 * makes `../x` an escape caught only because it happens to also be one.
 *
 * Nothing here touches the filesystem — whether the result exists, and what shape it is, are the
 * callers' questions and each of them asks a different one.
 */
export function hostPathOf(serial: DeviceSerial, dataRoot: string, devicePath: string): string {
	if (!isAbsolute(devicePath)) throw notAbsolute(serial, devicePath);

	const root = resolve(dataRoot);
	// `join` is what puts an absolute `devicePath` *under* the root rather than replacing it with
	// it, and it is what normalises the `..` segments away; `resolve` around it is only for the
	// trailing separator `join` leaves on a path that is all separators.
	const host = resolve(join(root, devicePath));

	if (!isInside(root, host)) throw escapesDataRoot(serial, devicePath);

	return host;
}

/**
 * Whether `candidate` is `root` or something under it.
 *
 * The separator is what makes the prefix test a path test rather than a string test: without
 * it `…/Devices/<udid>/data-of-someone-else` reads as being inside `…/Devices/<udid>/data`.
 * `root` is already `resolve`d by the one caller, so it carries no trailing separator unless it
 * is the filesystem root itself.
 */
function isInside(root: string, candidate: string): boolean {
	if (candidate === root) return true;
	return candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The refusal for a path that climbed out, naming the device and the path the **caller** wrote.
 *
 * Never the resolved host path: this message crosses the boundary as the text of an
 * `internal_error` (D19), and quoting where a `..` walk landed would answer a probe with the
 * layout of the machine it was probing. The caller's own path is the whole of what it needs to
 * fix, and `..` is named explicitly because it is the only way to get here.
 */
function escapesDataRoot(serial: DeviceSerial, devicePath: string): Error {
	return new Error(
		`'${devicePath}' resolves outside the storage of device '${unwrap(serial)}'. A path on ` +
			"this platform is resolved under that device's own data root, and one that climbs out " +
			'of it with `..` names a file on the machine lending the device rather than a file on ' +
			'the device. Name a path that stays inside it.',
	);
}

/** The refusal for a path with no leading `/`. See {@link hostPathOf}. */
function notAbsolute(serial: DeviceSerial, devicePath: string): Error {
	return new Error(
		`'${devicePath}' is not an absolute path, and a path on device '${unwrap(serial)}' has to ` +
			"be one: it is resolved under that device's own storage, so a relative path would be " +
			'read as if it had a leading slash rather than as the path it says. Write it as ' +
			`'/${devicePath}' if that is what was meant.`,
	);
}

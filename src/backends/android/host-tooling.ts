/**
 * What this backend needs installed on the host: `adb`, and nothing else.
 *
 * **Reported, never fetched.** `adb` ships in the Android SDK's `platform-tools`, and a machine
 * typically already holds several at different versions — adb kills a running server whose version
 * does not match the client that reached it, so a copy Rover downloaded could disrupt Android
 * Studio's session on the same machine, and would make the versions `PROJECT.md` §6 pins its
 * measurements to a property of who installed last (D32's reasoning, one step further out). The
 * honest row is `installable: false` and the search's own message, which already names every place
 * it looked.
 *
 * **The search is the daemon's own**, imported rather than re-derived (#171): `rover doctor` and
 * the verbs resolve `adb` through one list, so the report cannot describe a machine the daemon
 * would disagree with.
 */

import type { HostToolingProvider, HostToolStatus } from '../manifest.js';
import { ADB, findAdb } from './adb-locations.mjs';

export const androidHostTooling: HostToolingProvider = {
	describe: async () => [describeAdb()],
};

function describeAdb(): HostToolStatus {
	const candidate = findAdb();
	return candidate === null
		? {
				tool: ADB,
				found: null,
				detail:
					`No '${ADB}' in any of the places this host looks. Install the Android SDK's ` +
					'platform-tools, or set ROVER_ADB_PATH to the one this host should run.',
				installable: false,
			}
		: {
				tool: ADB,
				found: candidate.path,
				detail: `From ${candidate.source}.`,
				installable: false,
			};
}

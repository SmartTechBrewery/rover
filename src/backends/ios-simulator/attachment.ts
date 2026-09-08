/**
 * Whether a simulator is physically attached to this host — one constant, because there is
 * nothing to classify.
 *
 * A simulator is not *reached* from this host; it **is** this host. There is no transport
 * in front of it, no address, and nothing in `simctl list` that could name one, so this is
 * a constant rather than a function: a parameter invented for symmetry with
 * `../android/attachment.ts`' serial inspection would suggest a decision that is not being
 * made. The value of this module is the reasoning; the code is what follows from it.
 *
 * **D18's trap is worse here than on Android, not better.** `devicectl list devices` on a
 * Mac with nothing plugged in and no phone nearby reported (`docs/IOS.md` §7, measured
 * 2026-09-08):
 *
 * ```json
 * {"name": "iPhone (Jacek)", "udid": "00008030-000961893E07C02E", "platform": "iOS",
 *  "osVersion": "26.4.2", "tunnelState": "unavailable", "transportType": null,
 *  "pairingState": "paired",
 *  "potentialHostnames": ["iPhone-Jacek.coredevice.local", …]}
 * ```
 *
 * A **paired but absent** iPhone, served with a name, a udid, an OS version and a
 * hostname. Android's equivalent trap needed somebody to run a connect command first; this
 * platform serves it by default, forever, for every phone this Mac has ever been paired
 * with. Taking that enumeration at face value is the two-agents-one-device failure wearing
 * a disguise, and it is why the answer for hardware is written down here now while the
 * evidence is fresh rather than guessed at when the row that needs it is picked up.
 *
 * **The field that would decide a physical device is
 * `connectionProperties.transportType`:**
 *
 * | What the enumeration says | `attachment` |
 * |---|---|
 * | `wired` | `this-host` — the cable is the proof |
 * | `localNetwork` | `another-host` — reached over a network, so not this host's to lend (D18's letter) |
 * | `tunnelState: unavailable` | **not admissible either way**, and never `ready` |
 *
 * None of that runs here, and it deliberately does not: a physical device is outside this
 * backend entirely. Apple's supported path to one has no screenshot subcommand at all
 * while `screenshot` is a *required* method of `DeviceBackend` (`docs/IOS.md` §6), which is
 * also why the platform id in `./devices.ts` is `ios-simulator` rather than `ios` — naming
 * this one after the platform would promise hardware it cannot lend.
 */

import type { DeviceAttachment } from '../../core/device.js';

/** A simulator runs on this machine, so it is this machine's to lend (D18). */
export const SIMULATOR_ATTACHMENT: DeviceAttachment = 'this-host';

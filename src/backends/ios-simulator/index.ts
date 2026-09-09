/**
 * Side-effect-only registration for this backend.
 *
 * Imported once from `../index.js`; importing it is what puts this platform in the registry, and
 * nothing else in the repository names it (`ai/RULES.md` §2). No exports, so there is nothing to
 * call and no second way in — `../android/index.ts`'s shape, line for line.
 *
 * **This is the second backend to register, and the first one that registers with anything
 * declared `false`.** It does so now rather than in any of the four earlier phases because
 * `./backend.js` answers every required method of the contract *and* every method the three
 * capabilities `./capabilities.js` declares (`ai/TESTING.md`, "a backend under construction
 * registers nothing"). What the manifest declares it *cannot* do is an honest opt-out and not an
 * obstacle to registering; see `./capabilities.js`, which carries why each of the two is one.
 *
 * **It is also the first backend to register a host teardown**, because it is the first that keeps
 * a process of its own alive between calls: one supervised `idb_companion` per simulator any lease
 * has read (`./idb-client.js`). `stopHostProcesses` is what the daemon's shutdown calls to end them
 * (`../manifest.js`, `src/daemon/listen.ts`), and it is registered here rather than declared on
 * `DeviceBackend` because it is not a question about a device — `../android/index.ts` registers
 * none and needs none, its `adb` server not being this process's child.
 *
 * Its arrival is what flips the two tripwires in `tests/unit/backends/barrel.test.ts` and
 * `tests/unit/backends/conformance.test.ts` from `['android']` to `['android',
 * 'ios-simulator']` — their failure **is** the signal that a backend joined, which is the whole
 * reason they are written as an equality rather than a `toContain`.
 */

import { registerDeviceBackend } from '../registry.js';
import { IosSimulatorDeviceBackend } from './backend.js';
import { iosSimulatorCapabilityManifest } from './capabilities.js';
import { iosSimulatorHostTooling } from './host-tooling.js';

// Named rather than inlined into the registration, because the teardown below is a method *on this
// instance*: the companion pool is its state, so a second `new` here would hand the daemon a
// teardown for a backend nothing dispatches to and leave the real one's children behind.
const backend = new IosSimulatorDeviceBackend();

registerDeviceBackend({
	manifest: iosSimulatorCapabilityManifest,
	backend,
	stopHostProcesses: () => backend.stopIdbCompanions(),
	hostTooling: iosSimulatorHostTooling,
});

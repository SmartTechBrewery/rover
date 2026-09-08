/**
 * Side-effect-only registration for this backend.
 *
 * Imported once from `../index.js`; importing it is what puts this platform in the registry, and
 * nothing else in the repository names it (`ai/RULES.md` §2). No exports, so there is nothing to
 * call and no second way in — `../android/index.ts`'s shape, line for line.
 *
 * **This is the second backend to register, and the first one that registers with anything
 * declared `false`.** It does so now rather than in any of the four earlier phases because
 * `./backend.js` answers every required method of the contract *and* every method the two
 * capabilities `./capabilities.js` declares (`ai/TESTING.md`, "a backend under construction
 * registers nothing"). What the manifest declares it *cannot* do is an honest opt-out and not an
 * obstacle to registering; see `./capabilities.js`, which carries why each of the three is one.
 *
 * Its arrival is what flips the two tripwires in `tests/unit/backends/barrel.test.ts` and
 * `tests/unit/backends/conformance.test.ts` from `['android']` to `['android',
 * 'ios-simulator']` — their failure **is** the signal that a backend joined, which is the whole
 * reason they are written as an equality rather than a `toContain`.
 */

import { registerDeviceBackend } from '../registry.js';
import { IosSimulatorDeviceBackend } from './backend.js';
import { iosSimulatorCapabilityManifest } from './capabilities.js';

registerDeviceBackend({
	manifest: iosSimulatorCapabilityManifest,
	backend: new IosSimulatorDeviceBackend(),
});

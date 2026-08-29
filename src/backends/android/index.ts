/**
 * Side-effect-only registration for this backend.
 *
 * Imported once from `../index.js`; importing it is what puts this platform in the
 * registry, and nothing else in the repository names it (ai/RULES.md §2). No exports, so
 * there is nothing to call and no second way in.
 *
 * **This is the first backend to register.** It does so now rather than earlier because
 * `./backend.js` answers every required method of the contract for real — the rule is
 * ai/TESTING.md's "a backend under construction registers nothing", and the conformance
 * gate reads each method's own source to enforce it. What the manifest declares it
 * *cannot* do is an honest opt-out and not an obstacle to registering; see
 * `./capabilities.js`.
 */

import { registerDeviceBackend } from '../registry.js';
import { AndroidDeviceBackend } from './backend.js';
import { androidCapabilityManifest } from './capabilities.js';

registerDeviceBackend({
	manifest: androidCapabilityManifest,
	backend: new AndroidDeviceBackend(),
});

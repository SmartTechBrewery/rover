/**
 * Parser for a device type's own `profile.plist` — the file that carries the screen.
 *
 * Sibling of `./simctl-list.js` and pure for the same reason: it takes bytes a runner
 * already read and returns a shape. Nothing here spawns anything, opens a file or looks at
 * an environment variable, which is what lets the whole suite run on a machine with no
 * Xcode. The path to the file comes from the tool's own `bundlePath` (`../screen.js`), and
 * the mapping onto neutral vocabulary is `../screen.js`'s too; this module knows only
 * Apple's key names.
 *
 * **The file is a binary property list** (`bplist00`), not XML — measured on Xcode 26.4.1,
 * 2026-09-08, on all 124 device types the bench machine ships. So `fast-xml-parser`, the
 * dependency this repository already takes for a device tool's output format, cannot read
 * it. Two alternatives were rejected before the third was taken:
 *
 * - `plutil -convert json` is a **process**, and this folder starts none. A parser that
 *   spawns is a parser that cannot be tested without the platform it parses.
 * - A hand-rolled `bplist00` reader is ~200 lines of container-format code — offset tables,
 *   trailer, six integer widths — in a module that wants six numbers out of a file.
 *
 * So {@link readDeviceTypeProfile} takes the `bplist-parser` dependency, and it is
 * **deliberately the only thing in this phase that touches it**: the schema and the
 * arithmetic sit behind {@link parseDeviceTypeProfile}, which takes an already-decoded
 * object. If the dependency is ever refused or replaced, one four-line function changes and
 * everything pinned by the fixtures stays exactly as tested.
 */

import { parseBuffer } from 'bplist-parser';
import { z } from 'zod';

/**
 * The six keys of a device type's profile that describe its screen, plus the model.
 *
 * Non-`.strict()` for the reason `./simctl-list.js`'s `SimctlDeviceSchema` gives verbatim:
 * this is **Apple's** plist and it grows keys per Xcode release. The iPhone 17 Pro capture carries eighteen
 * top-level keys — `chromeIdentifier`, `framebufferMask`, `springBoardConfigName`,
 * `supportedFeatures` and the rest — and this reads six of them, so it is a projection of
 * the file rather than a record of it.
 *
 * Every one of the six is **required**, unlike the vendor keys that are stripped: all 124
 * device types on the bench carry all six (Xcode 26.4.1, 2026-09-08), and a profile without
 * them is not a screen this backend can describe. Absence is a loud failure naming the key,
 * not a `null` that reaches `ScreenInfo` as a plausible-looking nothing.
 *
 * Three of the types are measured rather than assumed:
 *
 * - **`mainScreenScale` is `z.number()`, not `z.number().int()`.** Most profiles encode it
 *   as a plist integer, but `Apple TV 4K (3rd generation) (at 1080p)` encodes the same
 *   value 1 as a plist *real*, and a Retina scale is a ratio in the first place. `.int()`
 *   here would reject a device type Xcode ships today.
 * - **The two DPI keys are `.int()`**, because `ScreenInfoSchema.density` is a positive
 *   integer. Every value measured is one (40, 80, 264, 326, 458, 460, 461, 476). A vendor
 *   release that ships a fractional DPI must fail here, naming the plist key an operator can
 *   go and look at, rather than be rounded on the way out into looking fine.
 * - **The two pixel counts are `.int()`**: they are a framebuffer's dimensions.
 */
export const DeviceTypeProfileSchema = z.object({
	/** Screen width in physical pixels — 1206 on an iPhone 17 Pro. */
	mainScreenWidth: z.number().int().positive(),
	/** Screen height in physical pixels — 2622 on an iPhone 17 Pro. */
	mainScreenHeight: z.number().int().positive(),
	/**
	 * Physical pixels per point — 3 on an iPhone 17 Pro, 2 on every iPad measured.
	 *
	 * **This is what idb's `describe` calls `density`** (`docs/IOS.md` §8, trap 6), and it is
	 * not a dpi. `../screen.js` is where that distinction is enforced.
	 */
	mainScreenScale: z.number().positive(),
	/** Horizontal dots per inch — 460 on an iPhone 17 Pro. The one `ScreenInfo.density` takes. */
	mainScreenWidthDPI: z.number().int().positive(),
	/**
	 * Vertical dots per inch. Equal to `mainScreenWidthDPI` on all 124 device types
	 * measured, and read so that `../screen.js` can refuse the day they differ rather than
	 * silently pick one.
	 */
	mainScreenHeightDPI: z.number().int().positive(),
	/** The hardware model behind the type — `iPhone18,1`. Names the device type in an error. */
	modelIdentifier: z.string().min(1),
});
export type DeviceTypeProfile = z.infer<typeof DeviceTypeProfileSchema>;

/**
 * Validate an already-decoded `profile.plist` object.
 *
 * Separate from {@link readDeviceTypeProfile} so the decode is the only part of this module
 * with a dependency behind it — see the module header.
 */
export function parseDeviceTypeProfile(decoded: unknown): DeviceTypeProfile {
	return DeviceTypeProfileSchema.parse(decoded);
}

/**
 * Decode a `profile.plist` and validate it.
 *
 * `bytes` is a `Uint8Array` because that is what every byte-carrying signature in
 * `src/core/device.ts` is. The view is re-wrapped rather than copied — `bplist-parser`
 * demands a real `Buffer` and rejects a plain `Uint8Array` with *"Expected 'bplist00' at
 * offset 0"*, which reads as a corrupt file rather than as the wrong container type it is.
 *
 * A decode failure is re-thrown naming the file, because the underlying message says only
 * what was wrong with the bytes and never which of them it was reading.
 */
export function readDeviceTypeProfile(bytes: Uint8Array): DeviceTypeProfile {
	const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

	let decoded: unknown;
	try {
		[decoded] = parseBuffer(buffer);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`profile.plist: not a readable binary property list: ${detail}`, {
			cause: error,
		});
	}

	return parseDeviceTypeProfile(decoded);
}

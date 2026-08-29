/**
 * What a capture off this platform looks like — the payload half of `screencap`.
 *
 * A predicate rather than a parser, but it lives here for the same reason the text
 * parsers do: `../adb.js` owns the process and `../backend.ts` is the join between the
 * two, so knowledge of what the device's output *is* belongs on this side and can be
 * tested without either a process or a device.
 */

/** The eight bytes every PNG starts with (PNG 1.2 §3.1). */
export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Whether a capture is a PNG at all.
 *
 * The cheap, loud check that catches a binary stream that came back mangled — decoded and
 * re-encoded, line-endings translated, or replaced by an error the caller would otherwise
 * hand an agent as an image. It deliberately judges **nothing else**: a valid PNG that is
 * entirely black is what a device with screen capture blocked returns (PROJECT.md §6), and
 * that is a real answer about the device rather than a failed capture, so it passes here
 * and is the caller's to interpret.
 */
export function isPng(bytes: Uint8Array): boolean {
	if (bytes.length < PNG_SIGNATURE.length) return false;
	return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

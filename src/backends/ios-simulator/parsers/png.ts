/**
 * What a capture off this platform has to be — the payload half of `simctl io screenshot`.
 *
 * A predicate rather than a parser, and it sits beside them for the reason its siblings give:
 * `../simctl.ts` owns the process and `../backend.ts` is the join between the two, so knowledge
 * of what the tool's output *is* belongs on this side, where it can be tested without a process
 * and without a simulator.
 *
 * **Its own eight bytes rather than an import of `../../android/parsers/screencap.ts`'s.** No
 * module under `src/backends/` imports from another backend's folder today, and this is not the
 * one to start: a backend is its own folder plus one barrel line (ai/CODING_STANDARDS.md), and a
 * capture predicate reaching across would tie this platform's screenshot to whether the other
 * platform still has one. What is duplicated is a published constant of the file format rather
 * than shared logic — `src/verbs/result.ts` and `src/daemon/frames.ts` each spell the same eight
 * bytes out, each citing the same section — and the two predicates guard different things.
 *
 * There the danger is a byte stream mangled in transit: `adb shell` may put a pty between the
 * device and the host, and a pty turns every 0x0a in the image into two bytes. Here the tool
 * writes the capture to a **file** this backend names and reads back, so nothing is in a position
 * to translate it. What this catches instead is `simctl` exiting 0 having written something that
 * is not the image it was asked for — an empty file, a truncated one, or an encoding other than
 * the `--type png` it was given — before those bytes are handed to an agent as a screenshot.
 */

/** The eight bytes every PNG starts with (PNG 1.2 §3.1). */
export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Whether a capture is a PNG at all.
 *
 * The cheap, loud check, and it deliberately judges **nothing else** — not whether the frame is
 * blank, black or mid-transition. Those are true answers about the device and belong to whoever
 * knows what was supposed to be on screen; on this platform they are also not what the Android
 * side's black frame is, since an app here cannot block a capture at all and every one came back
 * rendered (`docs/IOS.md` §8, trap 8).
 */
export function isPng(bytes: Uint8Array): boolean {
	if (bytes.length < PNG_SIGNATURE.length) return false;
	return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

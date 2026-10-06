/**
 * Verb-layer error types — the five ways a target fails to become one point to touch, the two
 * ways an answer is too big to give, and the ways this host cannot produce one at all.
 *
 * Device-layer errors (a missing capability, a device that vanished) stay in
 * `src/core/errors.ts`; these are about what the caller asked for, and every one of them
 * exists because the alternative is a **silent** answer: a first match among two, a tap
 * into nowhere or onto a keyboard, a truncated image, a frame list missing its middle, an
 * install nobody ran, or an empty result where the honest answer is that the screen no longer
 * holds what was named (ai/RULES.md §2).
 *
 * The last five are about a **host** rather than a device, and that is deliberate rather than
 * a stray. Frame extraction runs on the machine holding the hardware and needs a program that
 * may not be installed on it (`../daemon/frames.ts`), and a project's install is a command that
 * host's operator declared and this host runs (`../daemon/project-install.ts`) — both runners
 * live under `src/daemon/` precisely because they spawn, and nothing under `src/verbs/` may. A
 * missing host program and an unregistered project are not capabilities — capabilities describe
 * what a device backend can do (D11) — and neither is a bug, so they are answers with names like
 * the rest of these.
 *
 * **Every field is plain data on purpose**, for the reason `WaitTimeoutError` states: verb
 * execution happens on the host, so these are serialized and sent back over a socket that may
 * be a network one (D19). `./failure.ts` is where each of them becomes a parseable answer. A `ScreenElement` is itself plain data, which is why
 * the candidates can travel whole rather than as a formatted string.
 */

import type { Point, Rect, ScreenElement } from '../core/device.js';
import type { DeviceSerial } from '../core/ids.js';

/** How many elements an excerpt names before it says how many more there were. */
const EXCERPT_LIMIT = 8;

/** One element in the words an agent asked in — its text, its label, and where it is. */
export function describeElement(element: ScreenElement): string {
	const named = [element.text, element.label]
		.filter((value): value is string => value !== null)
		.map((value) => `'${value}'`);
	const { x, y, width, height } = element.bounds;
	return `${named.length > 0 ? named.join(' / ') : '(no text)'} [${element.id}] at ${x},${y} ${width}×${height}`;
}

/**
 * What was on screen instead — the second half ai/CODING_STANDARDS.md demands of every
 * failed lookup, bounded so a two-hundred-element screen is still readable.
 */
export function describeScreen(elements: readonly ScreenElement[]): string {
	if (elements.length === 0) {
		return 'an empty screen';
	}
	const excerpt = elements.slice(0, EXCERPT_LIMIT).map(describeElement);
	const remaining = elements.length - excerpt.length;
	const more = remaining > 0 ? `, and ${remaining} more` : '';
	const noun = elements.length === 1 ? 'element' : 'elements';
	return `${elements.length} ${noun}: ${excerpt.join('; ')}${more}`;
}

/**
 * Thrown when nothing on the freshly read screen matched the target.
 *
 * Carries what was looked for *and* what was there instead, because "not found" alone
 * makes the agent guess whether the screen had not loaded, had moved on, or never had
 * that element at all — three different next moves.
 */
export class TargetNotFoundError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly found: string;

	constructor(serial: DeviceSerial, lookedFor: string, found: string) {
		super(`Nothing on device '${serial}' matches ${lookedFor} — found ${found} instead`);
		this.name = 'TargetNotFoundError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.found = found;
	}
}

/**
 * Thrown when more than one element matched, naming **every** candidate.
 *
 * Two identical labels are exactly the false green the verb layer exists to prevent: a
 * silent first match taps one of them, reports success, and is right half the time. Being
 * told what is wrong without being told the way out is half an error, so the way out is
 * part of the message — and it is passed **in** rather than written here, because it is not
 * the same way out for every target. Only a text target has an `index` to disambiguate
 * with; two elements sharing one id is the backend contradicting itself, and advising an
 * `index` there would name a field `TargetSchema` rejects.
 */
export class AmbiguousTargetError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly candidates: readonly ScreenElement[];
	readonly remedy: string;

	constructor(
		serial: DeviceSerial,
		lookedFor: string,
		candidates: readonly ScreenElement[],
		remedy: string,
	) {
		super(
			`${candidates.length} elements on device '${serial}' match ${lookedFor}: ` +
				`${candidates.map((candidate, at) => `[${at}] ${describeElement(candidate)}`).join('; ')} ` +
				`— ${remedy}`,
		);
		this.name = 'AmbiguousTargetError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.candidates = candidates;
		this.remedy = remedy;
	}
}

/**
 * Thrown when a caller-supplied point lies outside the device's screen.
 *
 * A coordinate is the documented fallback (PROJECT.md §4) and the one address the verb
 * layer cannot re-derive from a screen read, so it is the one that has to be *range
 * checked* instead: an off-screen point otherwise dispatches an input event into nowhere,
 * which the device accepts without complaint and reports as having happened.
 *
 * Distinct from {@link TargetNotFoundError} because the answers differ — this is the
 * caller's arithmetic, not the screen's contents.
 */
export class OffScreenPointError extends Error {
	readonly serial: DeviceSerial;
	readonly x: number;
	readonly y: number;
	readonly widthDp: number;
	readonly heightDp: number;

	constructor(serial: DeviceSerial, x: number, y: number, widthDp: number, heightDp: number) {
		super(
			`Point (${x}, ${y}) is outside device '${serial}': its screen is ${widthDp}×${heightDp} ` +
				'in the coordinate space a screen read reports',
		);
		this.name = 'OffScreenPointError';
		this.serial = serial;
		this.x = x;
		this.y = y;
		this.widthDp = widthDp;
		this.heightDp = heightDp;
	}
}

/** Why the element a target named has no point on it that can be acted on. */
export type UnaddressableReason = 'clipped' | 'off-screen';

/**
 * Thrown when the element a target matched cannot be turned into a point to act on.
 *
 * Two shapes of the same failure, kept in one error because the caller's next move is the
 * same for both — bring the element into view and target it again:
 *
 * - `clipped` — the rectangle has no interior. A node scrolled past the edge of its
 *   container reports bounds whose second corner is *before* the first, so the width or
 *   the height comes back negative or zero (`PROJECT.md` §6, where the hierarchy parser
 *   that subtracts those corners deliberately hands the question on to this layer). Its
 *   midpoint is arithmetic, not a location.
 * - `off-screen` — the rectangle is well-formed but its centre is not on the device.
 *
 * Distinct from {@link OffScreenPointError} because the two name different culprits: that
 * one is the caller's arithmetic, this one is an element the screen read really did
 * report. Distinct from {@link TargetNotFoundError} because the element *was* found —
 * saying "not found" while listing it among what was on screen instead is the confusing
 * half-truth, not the honest answer.
 */
export class UnaddressableElementError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly element: ScreenElement;
	readonly point: Point;
	readonly widthDp: number;
	readonly heightDp: number;
	readonly reason: UnaddressableReason;

	constructor(
		serial: DeviceSerial,
		lookedFor: string,
		element: ScreenElement,
		point: Point,
		widthDp: number,
		heightDp: number,
		reason: UnaddressableReason,
	) {
		const why =
			reason === 'clipped'
				? 'its bounds have no interior — a node clipped out of its scrolling container ' +
					'reports a negative or zero size, so its midpoint is not a place on the screen'
				: `its centre (${point.x}, ${point.y}) is outside the device's ${widthDp}×${heightDp} screen`;
		super(
			`${describeElement(element)} on device '${serial}' matches ${lookedFor} but cannot be ` +
				`acted on: ${why}. Bring it into view — by scrolling, or by dismissing whatever ` +
				'covers it — and target it again',
		);
		this.name = 'UnaddressableElementError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.element = element;
		this.point = point;
		this.widthDp = widthDp;
		this.heightDp = heightDp;
		this.reason = reason;
	}
}

/**
 * Thrown when the point a touch would start at lies under the on-screen keyboard (#308).
 *
 * **The false green this closes**: the keyboard is drawn *over* the application, so an element
 * under it is still in the screen read with the bounds it was laid out at, still resolves, and
 * still has a centre on the device. A tap dispatched there lands on a key, the device accepts
 * it, and the verb reported `ok` for a button nothing touched (`PROJECT.md` §6). Refusing by name is the only answer that is not that,
 * and it is never a silent re-target to something visible, which would be the same lie told
 * about a different element.
 *
 * Kept apart from {@link UnaddressableElementError} rather than added as a third reason on it,
 * because the two describe different things. That one is an element with no point on it at
 * all — a rectangle with no interior, or a centre off the device. This is a well-formed point,
 * on the screen, with something drawn over it — and it has to work **with no element**:
 * `tap { by: 'point' }` names none, and `scroll`'s start is computed rather than resolved, so
 * `element` is `null` there and `lookedFor` says what the point was instead.
 *
 * The way out is part of the message for {@link AmbiguousTargetError}'s reason, and it is
 * `hide_keyboard` rather than generic advice: that verb presses nothing when no keyboard is up,
 * so it is safe to send without reading the screen first, where a `back` press is not.
 *
 * **The keyboard's own surface is the price, and it is a decision rather than an oversight**
 * (#318 review). There is no opt-out a caller can reach — `ResolveOptions.touchStartsHere` is
 * internal, and the two verbs that set it are exempting a point no touch lands on, not
 * exempting a touch — so while a keyboard is up the rectangle it occupies is unaddressable by
 * `tap`, `long_press` and the start of every drag, including `tap { by: 'point' }`, the
 * documented coordinate fallback. `press_key` (`enter`, `delete`, `tab`) and `type_text` are
 * then the **whole** remaining vocabulary for interacting with a keyboard, so an IME key with
 * no `DeviceKey` equivalent — the language switch, the emoji key, voice input, a suggestion
 * strip entry — has no verb that can reach it. That is accepted: a verb that could tap a key
 * could also tap one by accident, which is the false green this error exists to close, and the
 * refusal is loud rather than silent so nobody gets a wrong result from it. Anyone who later
 * needs an IME key is reopening this choice, not fixing a bug.
 */
export class CoveredByKeyboardError extends Error {
	readonly serial: DeviceSerial;
	readonly lookedFor: string;
	readonly element: ScreenElement | null;
	readonly point: Point;
	readonly keyboard: Rect;

	constructor(
		serial: DeviceSerial,
		lookedFor: string,
		element: ScreenElement | null,
		point: Point,
		keyboard: Rect,
	) {
		const what =
			element === null
				? `The ${lookedFor} on device '${serial}'`
				: `${describeElement(element)} on device '${serial}' matches ${lookedFor} but`;
		super(
			`${what} cannot be touched: the point (${point.x}, ${point.y}) lies under the ` +
				`on-screen keyboard at ${keyboard.x},${keyboard.y} ${keyboard.width}×${keyboard.height}, ` +
				'so the touch would land on a key rather than on the application. Dismiss it with ' +
				'hide_keyboard — which presses nothing when no keyboard is up — and target it again',
		);
		this.name = 'CoveredByKeyboardError';
		this.serial = serial;
		this.lookedFor = lookedFor;
		this.element = element;
		this.point = point;
		this.keyboard = keyboard;
	}
}

/**
 * Thrown when a captured artifact is larger than a verb answer may carry.
 *
 * The bound it names is {@link MAX_ARTIFACT_BYTES} (`./result.ts`), and this error is what
 * makes reaching it a **loud refusal rather than a truncated payload**. Truncation is the
 * failure mode worth spending an error class on: half a PNG still decodes to an image on
 * most readers, so an agent handed one sees a screen that is blank below a line and reads
 * it as something the device did — which is the plausible-looking wrong answer ai/RULES.md
 * §2 forbids, arriving in the one verb whose output nobody can sanity-check by eye.
 *
 * Distinct from the frame cap it is derived from: that one is a transport limit a client
 * discovers as a broken connection, and this is an answer about a capture, raised on the
 * host before anything is put on the wire.
 */
export class ArtifactTooLargeError extends Error {
	readonly serial: DeviceSerial;
	readonly byteLength: number;
	readonly maxBytes: number;

	constructor(serial: DeviceSerial, byteLength: number, maxBytes: number) {
		super(
			`The artifact captured from device '${serial}' is ${byteLength} bytes, over the ` +
				`${maxBytes}-byte limit one verb answer may carry — it travels base64-encoded, ` +
				'which is a third larger again, and the whole answer has to fit one message. ' +
				'It is refused whole rather than returned cut short, because a truncated image ' +
				'is not distinguishable from a screen that really looks like that',
		);
		this.name = 'ArtifactTooLargeError';
		this.serial = serial;
		this.byteLength = byteLength;
		this.maxBytes = maxBytes;
	}
}

/**
 * Thrown when the frame extractor could not be **started** — `ffmpeg` is not on this host's
 * `PATH`.
 *
 * **The branch that keeps `frames: []` from ever being an answer.** A recording that has
 * frames and a host that cannot slice it are two different facts, and an empty list conflates
 * them into the plausible-looking empty result ai/RULES.md §2 forbids: an agent reading one
 * concludes the screen never changed, which is a statement about the device made by a host
 * that never looked.
 *
 * Kept apart from {@link FrameExtractionFailedError} because the remedy differs — install the
 * program, rather than ask about this recording again — and apart from
 * `MissingCapabilityError` because that one is about a *device*: capabilities describe what a
 * backend can do, and nothing about a missing host program says anything about the hardware
 * (D11).
 *
 * `reason` is Node's own words for the failed spawn (`spawn ffmpeg ENOENT`), because a
 * program that is present but not executable fails here too and says so differently.
 */
export class FrameExtractionUnavailableError extends Error {
	readonly serial: DeviceSerial;
	readonly program: string;
	readonly reason: string;

	constructor(serial: DeviceSerial, program: string, reason: string) {
		super(
			`The recording from device '${serial}' could not be sliced into frames: '${program}' ` +
				`could not be started (${reason}). Install it on this host and put it on PATH — it ` +
				'is what decodes the recording. The recording itself is unaffected; it is the ' +
				'frames that cannot be produced, and an empty frame list would read as a screen ' +
				'on which nothing happened',
		);
		this.name = 'FrameExtractionUnavailableError';
		this.serial = serial;
		this.program = program;
		this.reason = reason;
	}
}

/**
 * Thrown when the frame extractor **ran** and did not produce frames.
 *
 * Distinct from {@link FrameExtractionUnavailableError} so a recording the decoder would not
 * read is distinguishable from a host that has no decoder — the first says something about
 * these bytes, the second about this machine, and they are fixed in different places.
 *
 * Carries the exit code and the program's own stderr together, because "a non-zero exit is
 * data" (ai/CODING_STANDARDS.md): the exit code alone says a decoder refused, and only its
 * stderr says whether the input was unreadable, the filter graph was rejected, or the run was
 * cut short. `outcome` is how the run ended in words — an exit, a signal, or a stream this
 * host could not read afterwards — because those three read identically from an exit code.
 */
export class FrameExtractionFailedError extends Error {
	readonly serial: DeviceSerial;
	readonly program: string;
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly outcome: string;

	constructor(
		serial: DeviceSerial,
		program: string,
		exitCode: number | null,
		stderr: string,
		outcome: string,
	) {
		super(
			`The recording from device '${serial}' could not be sliced into frames: ` +
				`'${program}' ${outcome}\nstderr: ${stderr.trimEnd().length === 0 ? '(empty)' : stderr.trimEnd()}`,
		);
		this.name = 'FrameExtractionFailedError';
		this.serial = serial;
		this.program = program;
		this.exitCode = exitCode;
		this.stderr = stderr;
		this.outcome = outcome;
	}
}

/**
 * Thrown when the recording could not be **normalised** because this host cannot run the
 * program that normalises it at all — `ffmpeg` is not on its `PATH`, or there is nowhere on it
 * the encoder may write (#185).
 *
 * **The branch that keeps a silently un-normalised file from ever being the answer.** What
 * `screenrecord` writes is not a constant-rate video: a capture of a screen that did not change
 * is one sample declaring no duration, which no player shows anything for, and an ordinary
 * capture declares a timeline that is not the one that was asked for
 * (`./recording-normalisation.ts`). Handing those bytes over anyway would put a file on a
 * client's disk and in the durable archive that the person who eventually opens it cannot tell
 * from a broken one — so a host that cannot normalise refuses **by name**, exactly as one that
 * cannot slice a recording into frames does.
 *
 * Kept apart from {@link RecordingNormalisationFailedError} for the reason
 * {@link FrameExtractionUnavailableError} is kept apart from its own pair: the remedy differs —
 * fix this machine, rather than ask about this recording again — and apart from
 * `MissingCapabilityError` because that one is about a *device* (D11), and nothing about a
 * missing host program says anything about the hardware.
 *
 * `reason` is what distinguishes the two ways a host can be unable to run it: Node's own words
 * for the failed spawn (`spawn ffmpeg ENOENT`), because a program that is present but not
 * executable fails there too and says so differently, or — the one condition the normaliser has
 * and the extractor does not, since only this tool needs a file — a temp directory it could not
 * create. **Never the path of that directory**, which is what D19 keeps out of answers.
 */
export class RecordingNormalisationUnavailableError extends Error {
	readonly serial: DeviceSerial;
	readonly program: string;
	readonly reason: string;

	constructor(serial: DeviceSerial, program: string, reason: string) {
		super(
			`The recording from device '${serial}' could not be normalised into a file that ` +
				`plays: this host cannot run '${program}' over it (${reason}). The remedy is on ` +
				'the host rather than in the call — the program on PATH, and a writable temporary ' +
				'directory for it to encode into; it is what re-encodes the recording onto a real ' +
				'timeline. The recording itself is unaffected and was pulled intact; what cannot ' +
				'be produced is a playable file, and handing over the un-normalised one quietly ' +
				'is not something this host will do',
		);
		this.name = 'RecordingNormalisationUnavailableError';
		this.serial = serial;
		this.program = program;
		this.reason = reason;
	}
}

/**
 * Thrown when the normaliser **ran** and did not produce a normalised recording.
 *
 * Distinct from {@link RecordingNormalisationUnavailableError} so a recording the encoder would
 * not read is distinguishable from a host that has no encoder — the first says something about
 * these bytes, the second about this machine, and they are fixed in different places.
 *
 * Carries the exit code and the program's own stderr together for
 * {@link FrameExtractionFailedError}'s reason ("a non-zero exit is data",
 * ai/CODING_STANDARDS.md), and `outcome` says how the run ended in words, because an exit, a
 * signal and an exit-0 that wrote no file at all read identically from a code. That last one is
 * a branch of its own here rather than a curiosity: it is the shape a build of `ffmpeg` without
 * the H.264 encoder takes, and the one path by which an un-normalised file could otherwise
 * become the answer.
 */
export class RecordingNormalisationFailedError extends Error {
	readonly serial: DeviceSerial;
	readonly program: string;
	readonly exitCode: number | null;
	readonly stderr: string;
	readonly outcome: string;

	constructor(
		serial: DeviceSerial,
		program: string,
		exitCode: number | null,
		stderr: string,
		outcome: string,
	) {
		super(
			`The recording from device '${serial}' could not be normalised into a file that ` +
				`plays: '${program}' ${outcome}\nstderr: ${stderr.trimEnd().length === 0 ? '(empty)' : stderr.trimEnd()}`,
		);
		this.name = 'RecordingNormalisationFailedError';
		this.serial = serial;
		this.program = program;
		this.exitCode = exitCode;
		this.stderr = stderr;
		this.outcome = outcome;
	}
}

/**
 * Thrown when `install_app` was asked for a project's own install and this host has never been
 * told about that project.
 *
 * **A configuration answer, not a host failure.** The lease's `project` is an opaque
 * caller-supplied string (D22) and a host is under no obligation to know it, so a call naming
 * one with no hook file is an ordinary "no" — and an `internal_error` here would send an agent
 * looking for a broken daemon over a file nobody created. It is also what the caller *can* fix:
 * send the package bytes, or ask the host's operator to register the project.
 *
 * Its own class rather than a shape of {@link InstallHookUndeclaredError} because the two are
 * fixed in different places — a file that does not exist, against a file that exists and says
 * nothing about installing — and an agent that cannot tell them apart re-sends the same call.
 *
 * **No path.** Where hook files live is the host's own directory layout and would name nothing
 * on the machine reading this (D19); the project is the caller's own string and travels back.
 */
export class ProjectNotRegisteredError extends Error {
	readonly serial: DeviceSerial;
	readonly project: string;

	constructor(serial: DeviceSerial, project: string) {
		super(
			`This host has no hook file for project '${project}', so there is nothing it could ` +
				`install onto device '${serial}' on that project's behalf. Send the package as ` +
				'bytes with the call, or have the host operator register the project — the core ' +
				"knows no application's name, so what installing means is the project's to declare",
		);
		this.name = 'ProjectNotRegisteredError';
		this.serial = serial;
		this.project = project;
	}
}

/**
 * Thrown when the project *is* registered and its hook file declares no `install` command.
 *
 * The branch that keeps a silent success from ever being an answer here. A registered project
 * with no install hook has nothing to run, and the two plausible-looking alternatives are both
 * the failure ai/RULES.md §2 forbids: an `ok` naming the device would report an install that
 * never happened, and a default command would be this tree guessing at an application's name
 * (D13).
 *
 * **This message is where an agent meets the failure, so it carries the steer and not only the
 * refusal** (#312). A refusal that names no remedy is read as permission to improvise, and the
 * improvisation available here is running the build's own install task directly — which, unless
 * it is pinned to one device, installs onto every device attached to the host, including the ones
 * other agents are holding leases on. That happened, and nothing failed anywhere: the neighbours
 * got a build they never asked for in the middle of their own runs. So the message says what not
 * to do next, in the same breath as saying what did not happen.
 */
export class InstallHookUndeclaredError extends Error {
	readonly serial: DeviceSerial;
	readonly project: string;

	constructor(serial: DeviceSerial, project: string) {
		super(
			`Project '${project}' is registered on this host but its hook file declares no ` +
				`'install' command, so nothing was installed onto device '${serial}'. Do not run ` +
				"the build's own install task against this host's devices instead: unless it is " +
				'pinned to one device it installs onto every device attached here, including ones ' +
				"other agents hold. Have the host operator add an 'install' to that file " +
				'(`rover init` proposes one) and call this again, or send the package as bytes ' +
				'with the call — there is no command Rover could guess, because the core knows no ' +
				"application's name",
		);
		this.name = 'InstallHookUndeclaredError';
		this.serial = serial;
		this.project = project;
	}
}

/**
 * Thrown when the project's install command **ran** and did not succeed.
 *
 * Kept apart from the two above because the remedy differs — this one says something about the
 * command and the build it drives, rather than about whether a file exists — and kept out of
 * `internal_error` for the reason a non-zero exit is data (ai/CODING_STANDARDS.md): a build that
 * failed to compile is an answer the agent acts on, not a host that broke.
 *
 * Carries the exit code and the tail of the command's own stderr together, because neither half
 * is worth much alone: the code says a program refused, and only its stderr says why. `signal`
 * beside it is what separates a command killed at `INSTALL_HOOK_TIMEOUT_MS` (`./files.ts`) from one that
 * exited on its own and from one that never started at all — three endings that read identically
 * from a null exit code — and `outcome` is the same distinction in the words a human reads.
 *
 * `command` is the program the hook file named, which is host-side configuration rather than a
 * path this answer promises anything about: it is there because a failure that cannot say *what*
 * failed leaves an operator grepping their own hook files.
 */
export class InstallHookFailedError extends Error {
	readonly serial: DeviceSerial;
	readonly project: string;
	readonly command: string;
	readonly exitCode: number | null;
	readonly signal: string | null;
	/** The last of what the command wrote to stderr — a tail, never all of it. */
	readonly stderr: string;
	readonly outcome: string;

	constructor(options: {
		serial: DeviceSerial;
		project: string;
		command: string;
		exitCode: number | null;
		signal: string | null;
		stderr: string;
		outcome: string;
	}) {
		super(
			`The install command '${options.command}' declared by project '${options.project}' ` +
				`${options.outcome}, so nothing was installed onto device '${options.serial}'` +
				`\nstderr: ${options.stderr.trimEnd().length === 0 ? '(empty)' : options.stderr.trimEnd()}`,
		);
		this.name = 'InstallHookFailedError';
		this.serial = options.serial;
		this.project = options.project;
		this.command = options.command;
		this.exitCode = options.exitCode;
		this.signal = options.signal;
		this.stderr = options.stderr;
		this.outcome = options.outcome;
	}
}

/**
 * Thrown when the frames extracted from a recording are larger than one answer may carry.
 *
 * The bound it names is `MAX_FRAMES_BYTES` (`./record.ts`), and this error is what makes
 * reaching it a **loud refusal rather than a shorter list**, the stance
 * {@link ArtifactTooLargeError} already takes for the recording itself. Trimming would be
 * worse here than anywhere else: a frame list quietly missing its middle reads as a recording
 * in which nothing happened between two moments that are no longer adjacent, and nothing
 * about the answer says otherwise.
 *
 * Its own class rather than {@link ArtifactTooLargeError} because the two ask different things
 * of the caller. That one is about a capture that will never fit whatever is done to it; this
 * one has two ways out — a shorter recording, or a lower `framesPerSecond` — and `frames` is
 * the number that says which is worth trying.
 */
export class FramesTooLargeError extends Error {
	readonly serial: DeviceSerial;
	readonly frames: number;
	readonly byteLength: number;
	readonly maxBytes: number;

	constructor(serial: DeviceSerial, frames: number, byteLength: number, maxBytes: number) {
		super(
			`The ${frames} frames extracted from the recording on device '${serial}' are ` +
				`${byteLength} bytes together, over the ${maxBytes}-byte limit one verb answer may ` +
				'carry beside the recording itself — they travel base64-encoded, which is a third ' +
				'larger again, and the whole answer has to fit one message. Record for less time, ' +
				'or ask for fewer frames a second. They are refused together rather than returned ' +
				'as a shorter list, because a frame list missing its middle reads as a recording ' +
				'in which nothing happened',
		);
		this.name = 'FramesTooLargeError';
		this.serial = serial;
		this.frames = frames;
		this.byteLength = byteLength;
		this.maxBytes = maxBytes;
	}
}

/**
 * The platform-neutral device contract — the seam every backend implements.
 *
 * The seam runs along *this interface*, not along the external programs a backend
 * happens to drive (PROJECT.md §5, and ai/ARCHITECTURE.md on where the seam runs). So
 * nothing here may assume one external tool per backend, one process, or that
 * enumeration is cheap: one platform's enumeration is a stream, another's is a poll.
 *
 * Zod is the source of truth for everything that crosses a boundary — these shapes
 * travel from the host to a client over IPC (PROJECT.md D19) — while `DeviceBackend`
 * itself is a plain interface, because a class instance is not a parseable value
 * (ai/CODING_STANDARDS.md "Zod is the source of truth").
 *
 * Methods split into two groups: the ones every backend must answer, and the ones a
 * backend opts into by declaring a capability (see `./capabilities.ts`). That split is
 * D11 — backends are genuinely asymmetric and flattening that is the design mistake to
 * avoid.
 */

import { z } from 'zod';
import {
	type AppId,
	type DeviceSerial,
	DeviceSerialSchema,
	ElementIdSchema,
	PlatformIdSchema,
} from './ids.js';

/**
 * What a device attached to this host can currently do. Neutral vocabulary, not any
 * one tool's words — a backend maps its own state strings onto these. Anything but
 * `ready` means "visible to the host, but no verb can run on it".
 */
export const DeviceStateSchema = z.enum(['ready', 'unauthorized', 'offline']);
export type DeviceState = z.infer<typeof DeviceStateSchema>;

/**
 * Whether a device is physically attached to this host.
 *
 * A host can *see* devices it is not holding: every platform this targets has a network
 * transport, and a device reached over one shows up in the enumeration indistinguishable
 * from a local device in everything but this flag. It is not this machine's hardware — it
 * can vanish without warning and may already belong to an unrelated process — so lending
 * it out is a promise this host cannot keep (D18, revised 2026-08-29).
 *
 * The backend classifies, because only it knows how its platform addresses a device; what
 * shared code does about the answer is shared code's decision.
 */
export const DeviceAttachmentSchema = z.enum(['this-host', 'another-host']);
export type DeviceAttachment = z.infer<typeof DeviceAttachmentSchema>;

/**
 * One device as the host sees it.
 *
 * Deliberately minimal, and the line is drawn by *what changes while a device is
 * attached* rather than by what a query costs. Screen size and density are what
 * `device_info` answers (PROJECT.md §4, D14): an override or a rotation moves them, so a
 * remembered one is a wrong one and they are paid for per call. The OS version does not
 * move — it is a static per-device fact — which is what makes reading it once per device
 * at enumeration reasonable, and what keeps it inside D6: whatever a host holds here it
 * re-derives at the next enumeration.
 *
 * Every field a device cannot always answer is nullable, `model` included: a device that
 * is not `ready` often cannot be asked anything at all, and a device the host can see is
 * a device the host reports.
 *
 * Which query answers the version, and how, is the owning backend's business — only it
 * knows how its platform reports one (ai/RULES.md §2).
 */
export const DeviceSchema = z.object({
	serial: DeviceSerialSchema,
	platform: PlatformIdSchema,
	model: z.string().nullable(),
	/**
	 * The user-facing OS version string, as the device reports it — the same fact
	 * {@link DeviceInfoSchema} carries, under the same name and with the same nullability,
	 * so a client reading one shape and a client reading the other read one vocabulary.
	 *
	 * Nullable, and a `null` here is a real answer rather than a failure: a device in a
	 * state that cannot be asked — one waiting on an authorization prompt is the common
	 * case — is reported **without** a version, never dropped from the enumeration and
	 * never a reason for the whole enumeration to fail. Losing the device list because one
	 * device is waiting on a prompt is the failure mode this nullability exists to prevent.
	 */
	osVersion: z.string().nullable(),
	/** The OS API level, where the platform has one. Null on `osVersion`'s terms. */
	osApiLevel: z.number().int().positive().nullable(),
	state: DeviceStateSchema,
	/**
	 * Whether this device is physically attached to this host (D18) — a snapshot that cannot
	 * say is not admissible to an inventory.
	 */
	attachment: DeviceAttachmentSchema,
});
export type Device = z.infer<typeof DeviceSchema>;

/**
 * The screen facts of one device, as the device itself reports them.
 *
 * Physical pixels and dp are both here because they answer different questions and
 * neither is recoverable from the other without the scale: a rectangle read off the
 * screen is in pixels, a design spec is in dp. `densityScale` is the one number that
 * converts between them, and it comes from the density the device reports — never from
 * the width of a captured image, which is off by a few percent and so reads as a pile of
 * small imperfections rather than as an arithmetic error (PROJECT.md §6).
 *
 * The dp values are exact quotients, deliberately unrounded: rounding is a presentation
 * decision, and a backend that rounds leaves no way to ask what the device actually said.
 */
/**
 * How far into the screen the system bars reach on each side, **in physical pixels** — the
 * same unit as {@link ScreenInfoSchema}'s `widthPx` and as a screenshot's own coordinates,
 * which is the whole point: a consumer comparing two screenshots must not have to multiply
 * by anything to use this.
 *
 * `0` on a side is a real answer and means *nothing reaches in from there*, which is the
 * ordinary case for left and right in portrait.
 *
 * **In the core vocabulary and not in a backend**, because it crosses the IPC boundary
 * inside `device_info` and is written into the archive beside every run (D14). Where the
 * numbers come from is each backend's own business (`PROJECT.md` §5): one that can ask its
 * device answers the four, and one with no route to the fact answers `null` rather than a
 * plausible-looking zero.
 */
export const SystemBarInsetsSchema = z
	.object({
		top: z.number().int().nonnegative(),
		bottom: z.number().int().nonnegative(),
		left: z.number().int().nonnegative(),
		right: z.number().int().nonnegative(),
	})
	.strict();
export type SystemBarInsets = z.infer<typeof SystemBarInsetsSchema>;

export const ScreenInfoSchema = z
	.object({
		/** Width in physical pixels, as currently rendered. */
		widthPx: z.number().int().positive(),
		/** Height in physical pixels, as currently rendered. */
		heightPx: z.number().int().positive(),
		/** Dots per inch, as the device reports it. */
		density: z.number().int().positive(),
		/** Physical pixels per density-independent pixel. */
		densityScale: z.number().positive(),
		/** `widthPx / densityScale`. */
		widthDp: z.number().positive(),
		/** `heightPx / densityScale`. */
		heightDp: z.number().positive(),
		/**
		 * Where this device draws its own system bars, in physical pixels — or `null` for a
		 * device that did not say.
		 *
		 * **`null` is *not answered* and four zeros are *no bars*, and they must not fold
		 * together**: the first leaves a consumer with nothing to set aside and the second tells
		 * it there is nothing to set aside. The panel's comparison card branches on exactly that
		 * difference (`docs/DESIGN.md` §9) — it is what decides whether the status bar's clock
		 * gets marked as a difference between two runs on every pair.
		 *
		 * **Nullable because the backends are genuinely asymmetric, not because a query might
		 * fail** (`ai/RULES.md` §2, `PROJECT.md` §5). One of them asks the system service that
		 * owns the screen's layout and gets the frames back. Another builds this whole shape from
		 * a static device-type description whose keys carry the screen and its scale and **nothing
		 * about the bars**, so there is nothing there to read — and writing a table of insets per
		 * device type from documentation is exactly the remembered fact `PROJECT.md` §6 exists to
		 * forbid, since the one platform that *can* be asked reports more than twice what the
		 * documentation for it says. A backend that cannot say answers `null`, and **no consumer
		 * anywhere branches on the platform to find that out**.
		 */
		systemBars: SystemBarInsetsSchema.nullable(),
	})
	.strict();
export type ScreenInfo = z.infer<typeof ScreenInfoSchema>;

/**
 * Everything `device_info` answers about one device (PROJECT.md §4).
 *
 * Separate from {@link DeviceSchema} because the screen it carries is measured *now*:
 * size and density move while a device is attached, so they are read per call and never
 * remembered. It repeats `serial`, `platform` and `model` rather than pointing at a
 * `Device`: D14 makes "names the device and its density" a property of the *result*, and
 * a measurement that travels without the device it was taken on is the contradiction D14
 * exists to prevent.
 *
 * `osVersion` and `osApiLevel` repeat {@link DeviceSchema}'s two fields for that same
 * reason, and deliberately under the same names: this shape is a self-contained answer,
 * not a delta on an enumeration a caller may not have. Both are nullable — a device that
 * answered hundreds of other facts but not that one has still answered
 * (ai/CODING_STANDARDS.md "Error handling").
 */
export const DeviceInfoSchema = z
	.object({
		serial: DeviceSerialSchema,
		platform: PlatformIdSchema,
		model: z.string().nullable(),
		screen: ScreenInfoSchema,
		/** The user-facing OS version string. */
		osVersion: z.string().nullable(),
		/** The OS API level, where the platform has one. */
		osApiLevel: z.number().int().positive().nullable(),
	})
	.strict();
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

/** A point in device-independent screen coordinates. */
export const PointSchema = z.object({
	x: z.number(),
	y: z.number(),
});
export type Point = z.infer<typeof PointSchema>;

/** An axis-aligned rectangle in the same coordinate space as {@link PointSchema}. */
export const RectSchema = z.object({
	x: z.number(),
	y: z.number(),
	width: z.number(),
	height: z.number(),
});
export type Rect = z.infer<typeof RectSchema>;

/**
 * One element of a screen read — the smallest shape a verb can resolve a target from.
 *
 * `text` and `label` are separate because the string a user sees and the string an
 * accessibility tree exposes are frequently different, and a verb that conflates them
 * taps the wrong thing. Both are nullable: plenty of elements carry neither.
 */
export const ScreenElementSchema = z.object({
	id: ElementIdSchema,
	text: z.string().nullable(),
	label: z.string().nullable(),
	bounds: RectSchema,
});
export type ScreenElement = z.infer<typeof ScreenElementSchema>;

/** The hardware/system keys the verb set names (PROJECT.md §4, "Input"). */
export const DeviceKeySchema = z.enum(['back', 'home', 'recents', 'wake']);
export type DeviceKey = z.infer<typeof DeviceKeySchema>;

/**
 * How severe one log entry is, in neutral vocabulary — never a platform's own letter.
 *
 * Ordered least to most severe, and deliberately six values rather than the four a host
 * language usually has: a system log's own vocabulary is what a backend maps *onto* this,
 * and collapsing `verbose` into `debug` on the way through would throw away the
 * distinction the device itself drew.
 */
export const LogLevelSchema = z.enum(['verbose', 'debug', 'info', 'warn', 'error', 'fatal']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

/**
 * One line of the device's own system log.
 *
 * `timestamp` stays the **string the device printed**, not an instant. The client shares
 * no clock with the device (D17), and the field is the device's own record of when it
 * said something rather than something the host is entitled to convert — one platform's
 * log prints no year at all, so reconstructing an epoch out of it would be inventing data
 * and then handing it over as if the device had said it.
 *
 * `pid` is nullable because a line the backend could not read a process out of is still a
 * line the device printed, and dropping it would put a silent hole in the one verb whose
 * job is to show what a screenshot cannot.
 */
export const LogEntrySchema = z
	.object({
		/** As the device reported it, verbatim. */
		timestamp: z.string(),
		level: LogLevelSchema,
		/** The subsystem the device attributed the line to; empty when it named none. */
		tag: z.string(),
		pid: z.number().int().nonnegative().nullable(),
		message: z.string(),
	})
	.strict();
export type LogEntry = z.infer<typeof LogEntrySchema>;

/**
 * One bounded read of the device's log — oldest entry first, so the last one is the most
 * recent thing the device said.
 *
 * `truncated` is what keeps a short read from reading as a quiet device: a log is a ring
 * buffer somebody else is also writing to, and "here are two hundred lines" means
 * something different when there were two hundred and one.
 */
export const LogReadSchema = z
	.object({
		entries: z.array(LogEntrySchema),
		/** True when the device had more to give than `maxEntries` and the oldest were dropped. */
		truncated: z.boolean(),
	})
	.strict();
export type LogRead = z.infer<typeof LogReadSchema>;

/**
 * What bounds one {@link DeviceBackend.readLogs} call.
 *
 * `maxEntries` is required rather than optional, and this is not a schema: the default is
 * the *verb's* (`src/verbs/logs.ts`), so a backend is never in the position of inventing
 * one and no two backends can invent different ones. Nothing here crosses a boundary —
 * what a caller sends is `ReadLogsParamsSchema` in `src/ipc/verb-methods.ts`.
 */
export interface ReadLogsOptions {
	/** The most entries to answer with. The device's own newest are the ones kept. */
	readonly maxEntries: number;
}

/**
 * What bounds one {@link DeviceBackend.pullFile} call.
 *
 * Required and passed down for {@link ReadLogsOptions}'s reason, with one more behind it:
 * the number belongs to the layer that knows what an *answer* may carry
 * (`MAX_ARTIFACT_BYTES`, `src/verbs/result.ts`), and the enforcement belongs to the layer
 * that is about to fetch the bytes. Splitting them is what keeps the refusal both correctly
 * sized and cheap — a backend that invented its own bound would disagree with the verb that
 * has to serialize the result, and a verb that checked afterwards would already be holding
 * what it refuses.
 */
export interface PullFileOptions {
	/** The most bytes the caller can be given. A larger file is refused, never truncated. */
	readonly maxBytes: number;
}

/**
 * What bounds one {@link DeviceBackend.recordVideo} call.
 *
 * One knob, because one is what a recording needs to be asked for. Frame rate, size and
 * bit rate are the backend's own business — a caller that could set them would be choosing
 * numbers only the backend knows the consequences of, and none of them changes what the
 * verb answers.
 *
 * Not a schema and not optional, for {@link ReadLogsOptions}' reasons: the default is the
 * *verb's* (`src/verbs/record.ts`), so no backend invents a second one, and what a caller
 * sends is `RecordVideoParamsSchema` in `src/ipc/verb-methods.ts`.
 */
export interface RecordVideoOptions {
	/**
	 * How long to record for. A backend may round this **up** to its own granularity and
	 * never down: a caller that asked for 2500 ms and got two seconds was quietly given
	 * less than it asked for, with nothing in the answer to say so.
	 *
	 * **Must be positive, and a backend rounding up floors at its own granularity rather than
	 * passing a zero on.** A recorder is typically given this duration as its own kill switch
	 * — the thing that stops it when the process driving it is gone — and at least one such
	 * tool reads a limit of zero as *no limit* (PROJECT.md §6). So the one value that looks
	 * like "record nothing" is the one that leaves an unbounded recorder on hardware the next
	 * lease gets. `RecordVideoParamsSchema` refuses it on the wire; an in-process caller of
	 * the core library never crosses the wire, which is why the floor belongs in the mapping
	 * as well.
	 */
	readonly durationMs: number;
}

/**
 * What bounds one {@link DeviceBackend.startRecording} call.
 *
 * One knob, and it is deliberately **not** how long to record for: the caller decides that by
 * *when it stops* (#190). What this bounds is the recorder's own kill switch — the limit that
 * makes a recorder which outlived the client that started it stop by itself rather than run on
 * under the next lease (PROJECT.md §6). It was the **only** thing bounding a stray recorder until
 * {@link discardRecording} landed the lease-end teardown (#191), and it is still required rather
 * than optional, because that teardown runs on this host: a host that died with the lease cannot
 * stop anything, and this limit does not need it to be alive.
 *
 * Not a schema and not optional, for {@link RecordVideoOptions}' reasons to the letter: the
 * default is the *verb's* (`src/verbs/record.ts`), so no backend invents a second one.
 */
export interface StartRecordingOptions {
	/**
	 * The longest the recorder may run before it stops itself, in milliseconds.
	 *
	 * **Must be positive**, and a backend rounding to its own granularity floors rather than
	 * passing a zero on — the same trap {@link RecordVideoOptions.durationMs} records, and here it
	 * is worse: nothing about this call is waiting on the recorder, so a limit of zero read as *no
	 * limit* leaves a recorder running on borrowed hardware with no call left to notice.
	 */
	readonly maxDurationMs: number;
}

/**
 * Why a backend's view of its device set was interrupted, in the cases where the backend
 * can say something a caller can **act on**.
 *
 * An interruption is normally transient and self-healing: whatever the backend was watching
 * through went away, and the backend re-establishes the view on its own within seconds
 * (PROJECT.md §6). That case has no cause here and is `null` — it is the one every client
 * already renders, and nothing about it changes.
 *
 * `tooling-missing` is the case that will **never** clear on its own: the program a backend
 * drives is not installed on this host, or is not in any of the places that backend looks for
 * it, so every attempt fails identically forever behind a generic "the view was interrupted"
 * message on every surface. It is classified from the error code the platform reports, never from
 * matching a message written for a human to read.
 *
 * One member today. It is an enum rather than a literal because the next permanent cause
 * worth naming joins it here, and a client written against the enum keeps working: an
 * unrecognised member means "the host named a cause this client does not know", which is
 * still more than `null` says.
 */
export const InterruptionCauseSchema = z
	.object({
		cause: z.enum(['tooling-missing']),
		/**
		 * The program the backend could not run. It is what makes a client's message actionable
		 * without any client knowing one platform's tooling: shared code renders the name the
		 * backend supplied and never learns what it is for (ai/RULES.md §2).
		 */
		tool: z.string().min(1),
	})
	.strict();
export type InterruptionCause = z.infer<typeof InterruptionCauseSchema>;

/**
 * The same cause, told by the host rather than by one backend: which platform's view is
 * the one that cannot be established.
 *
 * Derived rather than restated, so a field added to what a backend reports reaches the wire
 * without a second edit. The host supplies `platform` because the host is what knows which
 * backend it subscribed to — a backend never names its own platform to its watcher.
 */
export const StaleReasonSchema = InterruptionCauseSchema.extend({
	platform: PlatformIdSchema,
});
export type StaleReason = z.infer<typeof StaleReasonSchema>;

/**
 * What a {@link DeviceBackend.watchDevices} caller is told, as the set it watches changes.
 *
 * Neither method may throw. Both are called from inside the backend's own read path,
 * where there is nothing above them to catch — a listener with its own failures handles
 * them itself.
 */
export interface DeviceWatcher {
	/**
	 * The **full** current set: once on subscription, and again on every change. Never a
	 * delta, so a caller that missed one call is still correct after the next.
	 */
	onDevices(devices: Device[]): void;

	/**
	 * The backend lost its view of the platform's device set — what the caller last saw is
	 * no longer known to be current.
	 *
	 * This is not "no devices are attached", and the distinction is the whole reason the
	 * method exists: a lost view delivered as an empty set reads as every device having
	 * gone away, which for an inventory means releasing devices that never moved. The
	 * backend re-establishes the view on its own; the next {@link onDevices} supersedes
	 * this and needs no request from the caller.
	 *
	 * `reason` is a message written for a person to read and nothing may branch on it.
	 * `cause` is the machine-readable half — `null` for the transient case above, which is
	 * most of them, and otherwise the one thing a caller can do something about
	 * ({@link InterruptionCauseSchema}). It is a required argument rather than an optional
	 * one so that a backend answers the question deliberately: `null` says "this is expected
	 * to clear", which is a claim, not an omission.
	 */
	onInterrupted(reason: string, cause: InterruptionCause | null): void;
}

/** The handle {@link DeviceBackend.watchDevices} answers with. */
export interface DeviceWatch {
	/**
	 * Stop watching. No listener method is called after this resolves, and calling it a
	 * second time is a no-op rather than an error.
	 */
	stop(): Promise<void>;
}

/**
 * One backend's implementation of the device contract.
 *
 * Every method takes the serial it acts on: a backend serves every device of its platform
 * attached to this host, and the lease layer above it decides which serial a caller may
 * name.
 *
 * A backend holds **no state a caller has to manage, and none it cannot re-derive from its
 * platform** — which is D6 one level down. It may memo a device fact that does not change
 * while a device is attached — {@link DeviceSchema.shape.osVersion} is the one that is, and
 * a backend whose platform charges a query for it need not pay that on every enumeration,
 * a lease grant's re-verification among them. The price of the memo is fixed: it is
 * re-derived at enumeration, and a serial that leaves the device set takes its entry with
 * it. What a backend may never do is remember something a caller then has to invalidate, or
 * answer from a memo a fresh enumeration would contradict.
 *
 * The methods are **primitives**. `tap` takes a point, not a target — resolving a
 * target from a freshly captured screen is D12 and belongs in the verb layer, which is
 * the only place it can be enforced once for every backend.
 */
export interface DeviceBackend {
	// --- Required: every backend answers these (ai/ARCHITECTURE.md "The device abstraction") ---

	/**
	 * Every device of this backend's platform currently attached to this host.
	 *
	 * **It is an inventory of what can be borrowed now, not a catalogue of what this machine
	 * could run** (D41, #267). The distinction is invisible on a platform whose own tooling
	 * lists only what is running, and it is a decision on one whose tooling lists everything
	 * ever created: a virtual device that is not running is not a device this host has, in the
	 * same way a physical one nobody plugged in is not, so it is not listed either. Which
	 * platform is which is `PROJECT.md` §5's business and never this file's.
	 *
	 * **That is not licence to drop a device that is not `ready`.** A device that is present and
	 * unusable is still present and still says so — a device waiting on an authorization prompt
	 * is `unauthorized` here, and that row is the only clue its operator gets about why it cannot
	 * be leased. What a backend narrows on is presence, and it answers with a state.
	 */
	listDevices(): Promise<Device[]>;

	/**
	 * Watch the device set, calling `watcher` with the full set now and on every change.
	 *
	 * The set is {@link listDevices}' set, so the rule above is this method's rule too: what
	 * arrives and leaves is what can be borrowed.
	 *
	 * Required rather than capability-gated, for the same reason enumeration is: keeping
	 * one device off two agents is what this host exists to do, and a backend that cannot
	 * say when its device set changed leaves the host holding a snapshot it has no way to
	 * know is stale. A capability would make that opt-out look like a design choice.
	 *
	 * **Nothing here assumes a subscription.** One platform's enumeration is a stream and
	 * another's is a poll (ai/ARCHITECTURE.md); a backend on the second kind implements
	 * this by polling internally and calling {@link DeviceWatcher.onDevices} when the set
	 * differs. The obligation is "tell me when it changes", not "hand me a pipe".
	 *
	 * Synchronous, and never rejects: whether the underlying view could be established is
	 * reported through the listener, because a view that succeeds now and drops a minute
	 * later has to be reported *somehow* and one path for both is the only one a caller
	 * can be relied on to handle. A backend that can never establish it says so through
	 * {@link DeviceWatcher.onInterrupted} and keeps trying.
	 */
	watchDevices(watcher: DeviceWatcher): DeviceWatch;

	/**
	 * The current state of one device, or `null` when it is no longer attached
	 * (ai/CODING_STANDARDS.md "Error handling": `null` for not found).
	 *
	 * This is what "lifecycle" means in PROJECT.md §5 now that D21 has settled it:
	 * bringing hardware online is the host operator's physical work and never a verb, so
	 * the only lifecycle a backend observes is whether a device is still there and still
	 * usable. That is exactly the question D6's re-verification asks at every lease grant.
	 *
	 * **A backend may answer here for a device {@link listDevices} does not list**, and the two
	 * are not in disagreement when it does: that method answers "what is there to borrow" and
	 * this one answers "what is *this* device", asked by a caller who already has one in mind.
	 * The state is the answer either way, so a device narrowed out of the inventory says why —
	 * which is what a lease grant reports and what a refusal naming a state is made of.
	 */
	describeDevice(serial: DeviceSerial): Promise<Device | null>;

	/**
	 * The screen and OS facts of one device — what `device_info` answers.
	 *
	 * Required rather than capability-gated: D14 makes naming the device and its density a
	 * property of *every* result, so a backend that cannot answer this cannot satisfy D14
	 * at all. Throws when the device is gone, rather than answering `null` — `null` here is
	 * the lookup miss {@link describeDevice} reports, and reusing it would make "no such
	 * device" indistinguishable from "the query failed".
	 */
	deviceInfo(serial: DeviceSerial): Promise<DeviceInfo>;

	/** Install an application package from a path on the **host** (D19). */
	installApp(serial: DeviceSerial, packagePath: string): Promise<void>;

	/**
	 * The three app verbs take a parsed {@link AppId}, not a string.
	 *
	 * Not only to keep it apart from a serial. A backend generally cannot address an app
	 * without relaying this value into a command line the *device* interprets, and an
	 * unchecked one stops being an argument there and becomes a second command — run on
	 * hardware lent out for these verbs, with effects that outlive the lease. Branding the
	 * parameter is what forces every caller through `parseAppId` before any backend sees
	 * the value, rather than leaving each of them to be the only check.
	 */
	launchApp(serial: DeviceSerial, appId: AppId): Promise<void>;

	stopApp(serial: DeviceSerial, appId: AppId): Promise<void>;

	clearAppData(serial: DeviceSerial, appId: AppId): Promise<void>;

	/**
	 * Capture the screen as image bytes.
	 *
	 * Bytes, not a path: an artifact crosses the machine boundary and a host-local path
	 * handed to a client is a bug even when the client happens to be local (D19).
	 */
	screenshot(serial: DeviceSerial): Promise<Uint8Array>;

	/**
	 * The most recent entries of the device's own system log, parsed into neutral shapes.
	 *
	 * **Required rather than capability-gated**, and that is a decision rather than an
	 * oversight: `./capabilities.ts` says only genuinely divergent abilities get a flag and
	 * that "a capability that is always `true` would be noise". A system log is not one of
	 * the divergences — every platform this targets keeps one, and a backend that could not
	 * read it could not report a crash that left nothing on the screen, which is the whole
	 * reason this method exists.
	 *
	 * **A bounded read, never a follow.** A tail that stays open is a wait with no condition
	 * (ai/RULES.md §2) and a stream over IPC (D19); this answers with what the device has
	 * said so far and returns. Whether more was there is {@link LogRead.truncated}.
	 *
	 * Includes whatever buffer the platform records crashes in — a log read that shows
	 * ordinary chatter and silently omits the fatal exception is worse than no log at all.
	 */
	readLogs(serial: DeviceSerial, options: ReadLogsOptions): Promise<LogRead>;

	/**
	 * Copy a file from a path on **this host** onto a path on the device.
	 *
	 * A host path here is not the thing D19 forbids, and the asymmetry with
	 * {@link pullFile} below is the whole shape of this pair. The daemon runs on the host, so
	 * a path is a perfectly good way for one host-side layer to hand a file to another; what
	 * may never cross the machine boundary is a path *given to or taken from the caller*,
	 * because the caller is somewhere else. Whoever calls this has already turned the
	 * caller's bytes into a file of its own (`src/daemon/verb-handlers.ts`), the same way
	 * {@link installApp} is called.
	 *
	 * `devicePath` is validated as a shape at the boundary (`src/ipc/verb-methods.ts`) rather
	 * than escaped here: it is an argument to the transfer, not a fragment of a command line
	 * the device interprets, which is why this takes a plain string where the app verbs take
	 * a branded {@link AppId}. A backend that cannot keep that true — one that would have to
	 * relay the path through a shell on the device — quotes it itself, exactly as the app
	 * verbs' backends do.
	 *
	 * **`devicePath` names the file, never a directory to put it in**, and a backend that
	 * can tell the difference refuses the second rather than transferring into it. This is
	 * a rule rather than a device answer because the platforms' own transfer tools do not
	 * treat it as one: a push to a path that is already a directory copies the file
	 * *inside* it under the **host-side** basename and reports a success — measured, not
	 * assumed (PROJECT.md §6). So a caller that meant `/downloads/report.bin` and wrote
	 * `/downloads` is told `ok` about bytes it can no longer find, under a name this host
	 * invented. Leaving that to "the device's answer" is what makes it silent
	 * (ai/RULES.md §2).
	 *
	 * What happens to a path that already exists as a *file*, or is unwritable, is still
	 * the device's answer and comes back as one — an existing file is overwritten, which is
	 * what the caller asked for. Recursive directory transfer is deliberately not in this
	 * contract.
	 *
	 * **A directory is the only shape refused here, and the asymmetry with {@link pullFile}
	 * is deliberate rather than an omission.** That method refuses everything that is not a
	 * regular file, because on the way *out* a non-regular source is unbounded. On the way
	 * *in* there is nothing to bound: the bytes are a file this host already holds, the
	 * caller named the exact destination it meant, and what a device special file makes of
	 * them is the device's answer. A backend refuses a directory because a push into one
	 * lands under a basename this host invented; it does not otherwise second-guess the
	 * destination.
	 */
	pushFile(serial: DeviceSerial, hostPath: string, devicePath: string): Promise<void>;

	/**
	 * The bytes of a file on the device.
	 *
	 * **Bytes, not a path**, following {@link screenshot}'s precedent for exactly the same
	 * reason: the answer is read on the agent's machine, where a path this host wrote would
	 * name nothing — or, worse, would name something else entirely (D19). Where the bytes
	 * end up is the caller's own decision and the caller's own disk.
	 *
	 * A backend that stages the file on the host on the way through — most will, since that
	 * is what the platform's own transfer does — removes what it staged before answering.
	 * That copy is an implementation detail of the backend and never reaches the caller.
	 *
	 * Throws when the device has no such file: a missing file is not a device that answered
	 * with nothing, and answering with an empty array would be indistinguishable from an
	 * empty file that really is there.
	 *
	 * **The bound is not advisory, and it is not checked after the fact.** `options.maxBytes`
	 * is what the caller can be given, and a file over it is `FileTooLargeError` *before*
	 * this host has staged or buffered it — a refusal issued after the bytes have landed is
	 * an allocation the caller chose (`src/core/errors.ts`, {@link FileTooLargeError}).
	 *
	 * **`devicePath` names one *regular file*** — never a directory to read out of, and
	 * never a device special file, a fifo or a socket. This is the mirror of
	 * {@link pushFile}'s rule and, like it, a rule rather than a device answer — and here it
	 * is what keeps the bound above meaningful, because a regular file is the only shape
	 * whose reported size predicts what the transfer will fetch. The platforms' own transfer
	 * tools copy a directory *recursively*, while asking a device how big a directory is
	 * answers for the directory itself: a few kilobytes, whatever the tree under it holds. A
	 * character device is worse still — it reports **zero** and then reads forever
	 * (`/dev/urandom`, measured on API 37: PROJECT.md §6). So a backend that bounded on the
	 * reported number alone would admit an unbounded transfer, and would only find out once
	 * every byte of it was already on this host.
	 *
	 * A backend that can tell these apart therefore refuses **anything its probe does not
	 * call a regular file, before it moves a byte** — not a directory alone, and not by
	 * bounding harder afterwards, since after the transfer the disk is already spent. A
	 * backend whose probe cannot answer at all is left where it was before the probe existed;
	 * silently degrading to no bound is what this paragraph exists to prevent. Recursive
	 * directory transfer is deliberately not in this contract, in either direction.
	 */
	pullFile(serial: DeviceSerial, devicePath: string, options: PullFileOptions): Promise<Uint8Array>;

	// --- Capability-gated: present only when the manifest declares the capability ---

	/**
	 * Read the screen semantically. Gated by `canReadScreen`.
	 *
	 * Optional rather than required because on some platforms this has no cheap
	 * equivalent, and may have none at all (PROJECT.md §5, D11) — while on others it is
	 * the one read that survives an application blocking screen capture. A backend that
	 * cannot do it declares `canReadScreen: false`; it does not ship a method returning
	 * an empty list, which is the silent degradation D11 exists to prevent.
	 */
	readScreen?(serial: DeviceSerial): Promise<ScreenElement[]>;

	/** Gated by `canInput`. */
	tap?(serial: DeviceSerial, at: Point): Promise<void>;

	/** Gated by `canInput`. */
	swipe?(serial: DeviceSerial, from: Point, to: Point, durationMs: number): Promise<void>;

	/** Gated by `canInput`. Escaping of spaces and non-ASCII characters is the backend's job. */
	typeText?(serial: DeviceSerial, text: string): Promise<void>;

	/**
	 * Press one of the device's own keys. Gated by `canInput`.
	 *
	 * **{@link DeviceKey} is one shared vocabulary, not a promise that every platform has all
	 * of it.** A backend declaring `canInput` declares the *method*; the keys are its
	 * arguments, and platforms genuinely differ over which of them exist as a key at all
	 * (PROJECT.md §5).
	 *
	 * So a key this device has no equivalent for is `UnsupportedKeyError`
	 * (`src/core/errors.ts`), naming **that key** — which reaches the agent as an
	 * `unsupported-key` failure carrying it (`src/verbs/failure.ts`). Never
	 * `MissingCapabilityError`: this device does take input, and answering "cannot take
	 * input" would be the wrong answer to `tap`, `swipe` and `typeText`, which work, in order
	 * to answer for one key.
	 *
	 * **And never a substitute.** Pressing something that is not the key that was asked for,
	 * or resolving as though it pressed while having done nothing, is the silent degradation
	 * ai/RULES.md §2 forbids — sharpened here by the injection tooling this is implemented on
	 * top of, which accepts a key name it does not know in silence and exits successfully
	 * (PROJECT.md §6), so nothing downstream can detect the difference.
	 *
	 * **`canInput: false` is not the way to say it either.** That declares the method absent,
	 * which is a much larger claim than one missing key and takes three working verbs with it.
	 */
	pressKey?(serial: DeviceSerial, key: DeviceKey): Promise<void>;

	/**
	 * Gated by `canControlNetwork`. Together with {@link setWifiEnabled} this is the
	 * "environment" half of the device abstraction, and what the daemon restores on
	 * release and on expiry (D9).
	 */
	setAirplaneMode?(serial: DeviceSerial, enabled: boolean): Promise<void>;

	/** Gated by `canControlNetwork`. */
	setWifiEnabled?(serial: DeviceSerial, enabled: boolean): Promise<void>;

	/**
	 * Record the screen for `options.durationMs` and answer with the video bytes. Gated by
	 * `canRecordVideo`.
	 *
	 * **Bytes, never a path**, for {@link screenshot}'s reason: a recording crosses the
	 * machine boundary and a host-local path handed to a client is a bug even when the
	 * client happens to be local (D19).
	 *
	 * **It returns only once the recording has finished on the device *and* been pulled off
	 * it**, and that ordering is the whole contract rather than an implementation note. A
	 * recorder writes its container index last, so a file copied while the encoder is still
	 * running has no index at all — what comes back is not a short video, it is a file no
	 * decoder will open, which reads to an agent as a broken tool rather than as a race. An
	 * implementation checks the bytes it pulled and refuses them by name (`src/core/errors.ts`,
	 * `UnfinishedRecordingError`) rather than handing over something unreadable.
	 *
	 * **Completion is a condition with a timeout, never a sleep** (D12(b), ai/RULES.md §2).
	 * "The recorder process is gone" is a condition; "durationMs plus a bit" is a guess that
	 * is wrong on a loaded device, in the direction that corrupts the answer.
	 *
	 * The bound on duration is the caller's and the granularity is the backend's — see
	 * {@link RecordVideoOptions}.
	 *
	 * Optional rather than required because the divergence is real: one platform records a
	 * simulator with a command-line tool and has no cheap equivalent for a physical device
	 * (PROJECT.md §5, D11). A backend that cannot do it declares `canRecordVideo: false`
	 * rather than shipping a method that answers with an empty file.
	 */
	recordVideo?(serial: DeviceSerial, options: RecordVideoOptions): Promise<Uint8Array>;

	/**
	 * Start recording the screen and **return while the recorder is still running**. Gated by
	 * `canControlRecording`.
	 *
	 * The other half of {@link recordVideo}, not a replacement for it: that one is a window fixed
	 * before anything happens, this one is a recording an agent drives the device *inside* (#190).
	 * Both stay, because a caller that knows how long it wants should not have to make two calls
	 * to get it.
	 *
	 * **It answers when the recorder is running, not when it was asked to run.** "The recorder
	 * started" is a condition with a timeout, exactly as "the recorder is gone" is for
	 * {@link recordVideo} (D12(b), ai/RULES.md §2) — an implementation that returned as soon as it
	 * had spawned something would be answering `ok` for a recorder that failed to open its output,
	 * and the first anyone would hear of it is a {@link stopRecording} that finds nothing.
	 *
	 * **A device that is already recording is refused by name** (`src/core/errors.ts`,
	 * `RecordingAlreadyRunningError`), never queued behind the recording that is already there and
	 * never allowed to become a second recorder writing the same file. That refusal is the same
	 * one {@link recordVideo} gives on a device with a recording open, because it is the same fact
	 * about the device.
	 *
	 * **Nothing about the recording is remembered on the host.** Whether one is open is a question
	 * for the device, asked at the moment it matters (D6): a host that kept a flag would go on
	 * believing it across a daemon restart, a recorder that hit its own limit, and a recorder some
	 * other program on the host started.
	 */
	startRecording?(serial: DeviceSerial, options: StartRecordingOptions): Promise<void>;

	/**
	 * Stop the recording this device is holding open and answer with the video bytes. Gated by
	 * `canControlRecording`.
	 *
	 * **Bytes, never a path**, and **finished before they are handed over** — {@link recordVideo}'s
	 * two promises word for word, and made in the same two ways: the recorder is signalled and
	 * then *waited for on a condition* until it is gone, because it writes its container index as
	 * it exits, and the index is checked on the bytes that actually arrived rather than on any exit
	 * code. What did not finish is `UnfinishedRecordingError` naming the device and the byte
	 * length, never a file handed over (`src/core/errors.ts`).
	 *
	 * **A recorder that already stopped itself is not a failure.** It may have reached the limit
	 * {@link StartRecordingOptions.maxDurationMs} set; the file it left is complete and playable,
	 * and this answers with it. The failure is *nothing recorded at all* — no recorder and no file
	 * — which is `NoRecordingRunningError`, so a caller that stopped something it never started
	 * is told so rather than handed an empty answer.
	 *
	 * No options: everything that shapes the recording was decided when it started, and the one
	 * thing that decides its length is when this is called.
	 */
	stopRecording?(serial: DeviceSerial): Promise<Uint8Array>;

	/**
	 * Stop whatever recorder this device is running and remove the file it was writing. Gated by
	 * `canControlRecording`.
	 *
	 * **The teardown's method, not a verb's** (#191, R43 phase 3). Nothing calls this on behalf of
	 * an agent: `src/daemon/restore.ts` calls it when a lease ends, on release and on expiry
	 * alike, because a recorder that outlives its lease is exactly the teardown-that-only-runs-on-
	 * the-happy-path D9 exists to prevent — the next lessee would inherit a device that is still
	 * recording, and a multi-megabyte scratch file on hardware that is not theirs.
	 *
	 * **It deliberately does not pull, check or answer with bytes**, which is why it is a method of
	 * its own rather than a {@link stopRecording} the restoration ignores the answer of. That one
	 * would drag several megabytes off a device nobody is waiting on, and would then refuse an
	 * unfinished file (`UnfinishedRecordingError`) that a teardown has no reason to care about —
	 * a lease that ended has no caller left to hand a recording to, and writing one into the
	 * archive after the fact is a decision nobody has asked for. The bytes are dropped.
	 *
	 * **Nothing recording is the ordinary case, not a failure.** This runs for every lease that
	 * ends, and most leases never record anything: a device with no recorder and no file is a
	 * silent success, exactly as the radios are set without being read first. The failure it does
	 * report is the one that matters — a recorder that would not go away, or a file that could not
	 * be removed.
	 *
	 * **"The recorder is gone" is a condition with a timeout, never a sleep** (D12(b),
	 * ai/RULES.md §2), the same one {@link stopRecording} waits on and for the same measured
	 * reason.
	 */
	discardRecording?(serial: DeviceSerial): Promise<void>;
}

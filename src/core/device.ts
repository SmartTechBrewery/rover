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
 * Deliberately minimal: screen size, density and OS version are what `device_info`
 * answers (PROJECT.md §4, D14), and they cost a query per device — too expensive to pay
 * on every enumeration. `model` is nullable because a device that is not `ready` often
 * cannot be asked for one.
 */
export const DeviceSchema = z.object({
	serial: DeviceSerialSchema,
	platform: PlatformIdSchema,
	model: z.string().nullable(),
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
	})
	.strict();
export type ScreenInfo = z.infer<typeof ScreenInfoSchema>;

/**
 * Everything `device_info` answers about one device (PROJECT.md §4).
 *
 * Separate from {@link DeviceSchema} because these facts cost a query per device, which
 * is too expensive to pay on every enumeration. It repeats `serial`, `platform` and
 * `model` rather than pointing at a `Device`: D14 makes "names the device and its
 * density" a property of the *result*, and a measurement that travels without the device
 * it was taken on is the contradiction D14 exists to prevent.
 *
 * `osVersion` and `osApiLevel` are nullable — a device that answered hundreds of other
 * facts but not that one has still answered (ai/CODING_STANDARDS.md "Error handling").
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
	 */
	readonly durationMs: number;
}

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
	 */
	onInterrupted(reason: string): void;
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
 * Stateless, and every method takes the serial it acts on: a backend serves every
 * device of its platform attached to this host, and the lease layer above it decides
 * which serial a caller may name.
 *
 * The methods are **primitives**. `tap` takes a point, not a target — resolving a
 * target from a freshly captured screen is D12 and belongs in the verb layer, which is
 * the only place it can be enforced once for every backend.
 */
export interface DeviceBackend {
	// --- Required: every backend answers these (ai/ARCHITECTURE.md "The device abstraction") ---

	/** Every device of this backend's platform currently attached to this host. */
	listDevices(): Promise<Device[]>;

	/**
	 * Watch the device set, calling `watcher` with the full set now and on every change.
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

	/** Gated by `canInput`. */
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
}

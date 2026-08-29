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
	parseDeviceSerial,
	parseElementId,
	parsePlatformId,
} from './ids.js';

/**
 * What a device attached to this host can currently do. Neutral vocabulary, not any
 * one tool's words — a backend maps its own state strings onto these. Anything but
 * `ready` means "visible to the host, but no verb can run on it".
 */
export const DeviceStateSchema = z.enum(['ready', 'unauthorized', 'offline']);
export type DeviceState = z.infer<typeof DeviceStateSchema>;

/**
 * One device as the host sees it.
 *
 * Deliberately minimal: screen size, density and OS version are what `device_info`
 * answers (PROJECT.md §4, D14), and they cost a query per device — too expensive to pay
 * on every enumeration. `model` is nullable because a device that is not `ready` often
 * cannot be asked for one.
 */
export const DeviceSchema = z.object({
	serial: z.string().transform(parseDeviceSerial),
	platform: z.string().transform(parsePlatformId),
	model: z.string().nullable(),
	state: DeviceStateSchema,
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
		serial: z.string().transform(parseDeviceSerial),
		platform: z.string().transform(parsePlatformId),
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
	id: z.string().transform(parseElementId),
	text: z.string().nullable(),
	label: z.string().nullable(),
	bounds: RectSchema,
});
export type ScreenElement = z.infer<typeof ScreenElementSchema>;

/** The hardware/system keys the verb set names (PROJECT.md §4, "Input"). */
export const DeviceKeySchema = z.enum(['back', 'home', 'recents', 'wake']);
export type DeviceKey = z.infer<typeof DeviceKeySchema>;

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
}

/**
 * Parser for `simctl list -j` — the device map, the runtime list and the device types.
 *
 * Lives under `src/backends/` because it knows one platform's tool by name; nothing
 * outside a backend folder may (ai/RULES.md §2). Pure: it takes the text a runner
 * already captured and returns a shape. Spawning, timeouts and exit codes belong to the
 * runner, not here.
 *
 * **Indifferent to which invocation form produced its input.** `xcrun simctl list -j`
 * with no type argument answers all four listings at once — `devicetypes`, `runtimes`,
 * `devices`, `pairs` — even though `simctl list`'s own usage text says to specify one of
 * them, and `simctl list -j devices runtimes` works too (measured on Xcode 26.4.1,
 * 2026-09-08). The three top-level schemas below therefore each read **one** key and
 * ignore the rest, so an all-listings capture and a single-listing capture both parse;
 * both are committed in `tests/fixtures/ios-simulator/` for exactly that reason.
 *
 * **Nothing here reads the shape of an identifier.** A runtime's version comes from the
 * runtime *list*, joined on `identifier`, and never out of the device map's key — the key
 * is `com.apple.CoreSimulator.SimRuntime.iOS-26-4` while the matching runtime reports
 * `26.4.1`, so reading `26.4` out of it would report a version no installed runtime has.
 * That join is `../devices.js`'s job; this module reports what the tool printed and
 * decides nothing.
 */

import { z } from 'zod';

/**
 * One entry of one runtime's device list.
 *
 * **Non-`.strict()`, deliberately, where `AdbDeviceSchema` is strict.** That shape is
 * strict because *this repository constructs it* out of tokens — the key set is ours and
 * an added key is our bug. This one is **Apple's** JSON, and the vendor adds fields per
 * Xcode release: of the 22 entries in the committed capture, all carry `udid`, `name`,
 * `state`, `deviceTypeIdentifier`, `isAvailable`, `dataPath`, `dataPathSize` and
 * `logPath`, while only four carry `logPathSize` and only three `lastBootedAt`
 * (`tests/fixtures/ios-simulator/README.md`). Strictness here would turn an Xcode upgrade
 * into a load-time failure in a module that reads four fields and does not care about the
 * rest, so this is a **projection** of the JSON rather than a record of it and Zod's
 * default key-stripping is the wanted behaviour.
 *
 * `state` is an open string, not an enum, for `AdbDeviceSchema.state`'s reason verbatim:
 * the tokens `simctl` can print (`Shutdown`, `Booted`, `Booting`, `Shutting Down`,
 * `Creating`, …) are more than any fixture captures, and writing that list from memory is
 * the same mistake as a hand-written fixture. `../devices.js` encodes the one meaning that
 * is verified.
 *
 * **`isAvailable` and `availabilityError` are deliberately not read.** They say whether
 * the *runtime* is installed, which is not a device state — a device under an uninstalled
 * runtime still prints `Shutdown` and is still a device this host can see.
 */
export const SimctlDeviceSchema = z.object({
	udid: z.string().min(1),
	name: z.string(),
	/** Raw state token. May contain spaces — `Shutting Down` is one of them. */
	state: z.string().min(1),
	/**
	 * The device type this simulator was created from, and the join key onto
	 * {@link SimctlDeviceTypeSchema}: the type's own name, `modelIdentifier` and screen
	 * metrics are all in the `devicetypes` listing rather than here.
	 */
	deviceTypeIdentifier: z.string().min(1),
});
export type SimctlDevice = z.infer<typeof SimctlDeviceSchema>;

/**
 * One installed runtime.
 *
 * `platform` is how a watchOS or tvOS simulator is told from an iPhone one **without**
 * reading a name or an identifier — the tool answers it (`"iOS"`), so nothing has to infer
 * it.
 */
export const SimctlRuntimeSchema = z.object({
	identifier: z.string().min(1),
	/** The user-facing version. The one field `../devices.js` may read a version from. */
	version: z.string().min(1),
	platform: z.string().min(1),
});
export type SimctlRuntime = z.infer<typeof SimctlRuntimeSchema>;

/**
 * One device type — the *model* a simulator is created from, not a simulator.
 *
 * `bundlePath` is the field this listing exists for. A device type's screen metrics live in
 * a `profile.plist` inside that bundle (`./device-type-profile.js`), and the path to it is
 * **taken from the tool rather than assembled from a guessed layout**: on the bench machine
 * every bundle sits under `/Library/Developer/CoreSimulator/Profiles/DeviceTypes/`, which is
 * *not* under `DEVELOPER_DIR` — an Xcode-relative path would miss all 124 of them (measured
 * on Xcode 26.4.1, 2026-09-08). The tool knows where it put them; nothing here has to.
 *
 * `modelIdentifier` (`iPhone18,1`) is the hardware model behind the type, and the only place
 * one is available at all: a device entry carries a *name* and this carries the model.
 *
 * Same non-`.strict()` projection as {@link SimctlDeviceSchema} and for the same reason —
 * all 124 entries of the committed capture carry nine keys and this reads four, so the five
 * unread ones (`productFamily`, `minRuntimeVersion`, `maxRuntimeVersion` and their two string
 * forms) are stripped rather than recorded.
 */
export const SimctlDeviceTypeSchema = z.object({
	identifier: z.string().min(1),
	name: z.string().min(1),
	/** Absolute path to the `.simdevicetype` bundle. See this schema's header. */
	bundlePath: z.string().min(1),
	modelIdentifier: z.string().min(1),
});
export type SimctlDeviceType = z.infer<typeof SimctlDeviceTypeSchema>;

/** The `devices` listing: one array of devices per runtime identifier. */
export const SimctlDeviceListSchema = z.object({
	devices: z.record(z.string(), z.array(SimctlDeviceSchema)),
});
export type SimctlDeviceList = z.infer<typeof SimctlDeviceListSchema>;

/** The `runtimes` listing. */
export const SimctlRuntimeListSchema = z.object({
	runtimes: z.array(SimctlRuntimeSchema),
});
export type SimctlRuntimeList = z.infer<typeof SimctlRuntimeListSchema>;

/** The `devicetypes` listing. One word in Apple's JSON, where every other name here is camel. */
export const SimctlDeviceTypeListSchema = z.object({
	devicetypes: z.array(SimctlDeviceTypeSchema),
});
export type SimctlDeviceTypeList = z.infer<typeof SimctlDeviceTypeListSchema>;

/**
 * The error for output that is not JSON at all.
 *
 * A real path rather than a defensive one: on a machine whose `xcode-select` points at
 * CommandLineTools, `xcrun simctl` prints *"unable to find utility simctl, not a developer
 * tool or in PATH"* (`docs/IOS.md` §1), and a caller that merged the two streams hands
 * exactly that text to these functions. Quotes the output verbatim, because the message is
 * the only place a reader learns which of the several failures it was.
 */
function unparseable(command: string, stdout: string, cause: unknown): Error {
	return new Error(`${command}: output is not JSON:\n${stdout.trimEnd()}`, { cause });
}

function parseJson(command: string, stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch (error) {
		throw unparseable(command, stdout, error);
	}
}

/**
 * Parse the `devices` listing out of `simctl list -j` output.
 *
 * An empty `devices` map is a real answer and returns `{}` — a host with no simulators
 * created, which is not a failure to surface.
 */
export function parseSimctlDevices(stdout: string): SimctlDeviceList {
	return SimctlDeviceListSchema.parse(parseJson('simctl list -j devices', stdout));
}

/** Parse the `runtimes` listing out of `simctl list -j` output. */
export function parseSimctlRuntimes(stdout: string): SimctlRuntimeList {
	return SimctlRuntimeListSchema.parse(parseJson('simctl list -j runtimes', stdout));
}

/**
 * Parse the `devicetypes` listing out of `simctl list -j` output.
 *
 * Every type Xcode ships, not the ones this host has simulators for — 124 entries against 22
 * devices in the committed capture, and every Apple TV, Watch and Vision Pro type among them.
 * Selecting the one a device was created from is a join on `deviceTypeIdentifier`, which is
 * `../devices.js`'s business; this reports what the tool printed.
 */
export function parseSimctlDeviceTypes(stdout: string): SimctlDeviceTypeList {
	return SimctlDeviceTypeListSchema.parse(parseJson('simctl list -j devicetypes', stdout));
}

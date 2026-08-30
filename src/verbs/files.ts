/**
 * The three verbs that move a file across the machine boundary — `install_app`, `push_file`
 * and `pull_file` (PROJECT.md §4, "App and environment"; backlog row R15, phase 3).
 *
 * **This is the family whose whole subject is *which machine* a file is on.** The agent is
 * somewhere else (D17), the device is here, and the host is in between: so a package to
 * install and a file to push come **from the caller's machine** as bytes, and a pulled file
 * goes back **as bytes**. No path a caller sends or receives ever names something on this
 * host (D19). The host-local file each direction needs exists for the length of one call and
 * is the caller of these verbs' business, not theirs — `src/daemon/verb-handlers.ts` writes
 * it, hands the path down, and removes it in a `finally`.
 *
 * **`install_app` has a second shape, and it is the one that knows no application's name
 * either.** A caller may send no bytes at all, and then the host runs what *the lease's
 * project* declared installing to be — a build, a deploy script, whatever that project already
 * has (D13/R17, `src/daemon/project-hooks.ts`). Both shapes are the same verb because they are
 * one operation (D10): same name, same answer, same after-state. What differs is only where the
 * thing to install came from, and the schema says which arrived
 * (`InstallAppParamsSchema.packageBase64`). The command itself is never named here — this layer
 * declares a {@link ProjectInstaller} and the daemon supplies one — because running it starts a
 * process, and nothing under `src/verbs/` may (D19).
 *
 * **They are the same spine as every other verb** (`./perform.ts`), with `requires: []` and
 * no target, for the reasons `./app.ts` records for the app family: `installApp`, `pushFile`
 * and `pullFile` are *required* methods of `DeviceBackend`, so there is no capability to
 * assert — one that is always true is the noise `src/core/capabilities.ts` warns against —
 * and a file addresses a path rather than something on the screen, so `ActionResult.target`
 * is `null` as a fact about the verb rather than a resolution that failed. What the spine
 * still buys them is D12(c) and D14: the state after the transfer, and the device named in
 * the answer.
 *
 * **`pull_file` answers on `ActionResult.artifact`, exactly where `screenshot` does**
 * (`./read.ts`), rather than in a result shape of its own the way `read_logs` needs. Bytes
 * are what `artifact` is for, and the reuse buys three things that would otherwise each have
 * to be built again: `artifactFrom` refuses an over-sized answer **by name** rather than
 * cutting it (`artifact-too-large`, carrying both numbers), the encoding is the one every
 * client already decodes, and — the load-bearing one — the answer then contains **no path at
 * all**, which is the property `tests/unit/verbs/serializable.test.ts` walks every result for.
 * An extended result would have had somewhere to put a device path, and the first thing that
 * would be read as is a place a file is.
 *
 * **The size limits are two, one per direction, and both are named.** What a call may carry
 * in is `MAX_TRANSFER_BYTES` (`src/ipc/verb-methods.ts`), enforced at the boundary so an
 * over-sized `install_app` is `invalid_params` before the host has decoded anything. What an
 * answer may carry out is `MAX_ARTIFACT_BYTES` (`./result.ts`). They are the same number
 * today and are still two constants, because they bound different things: the row that
 * raises them is R24, and it raises them by replacing the mechanism underneath rather than
 * by changing what these verbs promise.
 *
 * **A real application package is routinely larger than the cap**, and that is said out loud
 * here and in the refusal rather than discovered: `install_app` moves a small package today
 * and refuses a large one by name. Chunking, resumption and streaming are R24's row.
 */

import { FileTooLargeError } from '../core/errors.js';
import type { DeviceSerial } from '../core/ids.js';
import type { VerbContext } from './context.js';
import { ArtifactTooLargeError } from './errors.js';
import { performAction } from './perform.js';
import {
	type ActionResult,
	ActionResultSchema,
	type Artifact,
	artifactFrom,
	MAX_ARTIFACT_BYTES,
} from './result.js';

/**
 * Install an application package that is already on this host, onto the leased device.
 *
 * `packagePath` is a path **on the host** and never one a caller sent: the daemon's handler
 * decodes the caller's bytes into a file of its own before this runs (D19). It is pinned to
 * the device the lease names all the way down — an unpinned install landing on another
 * agent's device is the worst failure this tool has and looks like success from both sides
 * (PROJECT.md §2), which is why the backend's runner takes the serial rather than letting
 * the tool underneath pick.
 *
 * Nothing here knows what application this is, and nothing should: the core knows no
 * application's name (D13/R17), so what is installed is the package the caller supplied. The
 * other half of that sentence is {@link installProjectApp}, where the *project* says what
 * installing means and this layer still never learns an application's name.
 */
export async function installApp(context: VerbContext, packagePath: string): Promise<ActionResult> {
	return performAction(context, {
		verb: 'install_app',
		requires: [],
		act: async () => {
			await context.backend.installApp(context.serial, packagePath);
		},
	});
}

/**
 * How a project's own install runs — declared here, implemented on the host.
 *
 * **The verb layer names the shape and never the command**, exactly as `FrameExtractor`
 * (`./record.ts`) names the slicing and never the decoder, and for the same mechanical reason:
 * running what a hook file declares starts a process, and a process started anywhere under
 * `src/verbs/` would put `node:child_process` in every client's module graph, since
 * `src/ipc/verb-methods.ts` imports these schemas (D19,
 * `tests/unit/daemon/remote-never-spawns.test.ts`). So the daemon supplies it
 * (`src/daemon/project-install.ts`), exactly as it supplies `context.backend`.
 *
 * **It takes the serial rather than closing over one**, and that is the pinning made
 * structural: what the implementation is handed is the device this verb is running against —
 * which came from the lease and from nothing a caller sent — so it cannot pick its own. An
 * install aimed at a neighbour's device is the worst failure this tool has and looks like
 * success from both sides (PROJECT.md §2), so the serial travels down the same way the
 * package path does rather than being resolved a second time further in.
 *
 * It is not a `Capabilities` flag for `FrameExtractor`'s reason: whether a project has
 * declared an install is a fact about this **host's configuration**, not about the device, and
 * capabilities describe what a backend can do (D11).
 */
export type ProjectInstaller = (serial: DeviceSerial) => Promise<void>;

/**
 * How long a project's install command may run before it is killed and the failure says so —
 * five minutes.
 *
 * **A verb-layer bound rather than the runner's own**, for the reason
 * `FRAME_EXTRACTION_TIMEOUT_MS` is one: the number has to be visible to the *client*, whose
 * request timeout covers the whole call and has to be larger than every budget inside it, and a
 * client cannot import a daemon module without putting a process spawn in its module graph
 * (D19). So it lives here, beside the other numbers that say how long this verb can take.
 *
 * **Generous on purpose, because this is a build and not a teardown.** `HOOK_COMMAND_TIMEOUT_MS`
 * (8 s, `src/daemon/hook-command.ts`) bounds a hook that stops a helper service while a grant
 * queues behind it; nothing queues behind this one, and a real project's install compiles, links
 * and pushes. Its two relationships are stated rather than discovered, and
 * `tests/unit/verbs/files.test.ts` asserts both:
 *
 * - **Against the lease TTL (D8)**: `LEASE_TTL_MS` is twenty minutes and the lease is renewed
 *   when the call *arrives*, so an install may not outlive it — a lease expiring under a running
 *   install would fire restoration on a device the verb is still driving. Five minutes is a
 *   quarter of the TTL, which leaves the same headroom `MAX_VERB_TIMEOUT_MS` was chosen for and
 *   makes that unreachable rather than merely unlikely.
 * - **Against the client's request timeout**: `DEFAULT_REQUEST_TIMEOUT_MS` is 30 s
 *   (`src/ipc/client.ts`), so a caller asking for a project install **must** raise its own
 *   `IpcRequestOptions.timeoutMs` past this, the way `rover record` already derives one from the
 *   budgets inside its call. A caller that does not gets a timeout on its own end while the
 *   build keeps running on the host — which is a hang reported at the wrong machine.
 */
export const INSTALL_HOOK_TIMEOUT_MS = 5 * 60_000;

/**
 * Install **this project's** application, by running what the project declared.
 *
 * The same verb name as {@link installApp} and the same spine, deliberately: bytes from the
 * caller and a project's own install command are two ways to answer one request, and one
 * operation gets one vocabulary (D10). So an agent reads back `verb: 'install_app'`, the state
 * after the install and the device it happened on (D12(c), D14) whichever way it asked, and
 * nothing in the answer is a path — what the command was is host-side configuration, and the
 * only place it surfaces is a named failure (`./errors.ts`).
 *
 * Nothing here knows what application this is either, and that is the point of the seam rather
 * than a gap in it: the host looks the lease's `project` up in that project's own hook file and
 * runs what it finds, so the name lives in the operator's configuration and never in this tree
 * (D13/R17).
 *
 * @throws ProjectNotRegisteredError when the lease's project has no hook file on this host.
 * @throws InstallHookUndeclaredError when that file declares no `install` command.
 * @throws InstallHookFailedError when the command ran and did not succeed.
 */
export async function installProjectApp(
	context: VerbContext,
	install: ProjectInstaller,
): Promise<ActionResult> {
	return performAction(context, {
		verb: 'install_app',
		requires: [],
		act: async () => {
			await install(context.serial);
		},
	});
}

/**
 * Put a file on the device, at the path the caller named.
 *
 * `hostPath` is the host-side file the handler wrote from the caller's bytes; `devicePath`
 * is the caller's own and was checked as a shape at the boundary (`DevicePathSchema`) rather
 * than escaped, because nothing between here and the device interprets it.
 *
 * What happens to a path that already exists as a file, or cannot be written, is the
 * *device's* answer and comes back as one. A path that is already a **directory** is not one
 * of those: the platforms' own transfers copy the file inside it under a name this host
 * invented and call that a success, so `DeviceBackend.pushFile` refuses it instead — see
 * that contract for why the rule is the backend's and not the device's. Recursive directory
 * transfer is deliberately not this verb.
 */
export async function pushFile(
	context: VerbContext,
	hostPath: string,
	devicePath: string,
): Promise<ActionResult> {
	return performAction(context, {
		verb: 'push_file',
		requires: [],
		act: async () => {
			await context.backend.pushFile(context.serial, hostPath, devicePath);
		},
	});
}

/**
 * Read a file off the device and answer with its bytes.
 *
 * The bytes come back on `result.artifact` — base64, a media type read off the bytes
 * themselves, and the length they decode to — and **the client writes them wherever it
 * likes**. There is no path in the answer: the read happened on the host, the answer is read
 * on the agent's machine, and a filesystem location would name nothing there or, worse,
 * something else (D19). The durable copy this host could keep is D23/R25 and is not this
 * verb's.
 *
 * A file too large for one answer is refused by name, carrying its size and the bound,
 * rather than cut to fit — see `./result.ts` for why truncation is the failure mode worth
 * spending an error on. Encoded inside the action, so the refusal costs no screen read.
 */
export async function pullFile(context: VerbContext, devicePath: string): Promise<ActionResult> {
	let pulled: Artifact | null = null;

	const result = await performAction(context, {
		verb: 'pull_file',
		requires: [],
		act: async () => {
			pulled = artifactFrom(context.serial, await read(context, devicePath));
		},
	});

	// Re-parsed rather than spread and returned, so the artifact is held to the same schema
	// the spine's own answer was — `./read.ts`'s `screenshot` assembles its result the same way.
	return ActionResultSchema.parse({ ...result, artifact: pulled });
}

/**
 * The bytes, with the bound the answer will be held to handed **down** rather than applied
 * on the way back.
 *
 * `artifactFrom` above is still the check that decides what an answer may carry, and it is
 * unchanged; this is the same number, given to the layer that is about to fetch the file so
 * that a refusal costs nothing. Without it a 2 GB recording on the device is copied onto
 * the host and read into the daemon's heap before `artifactFrom` says what was knowable
 * from its size alone — and the daemon holds every lease on the machine (D6, D17), so
 * exhausting it is not one caller's problem.
 *
 * The backend answers in the device layer's vocabulary ({@link FileTooLargeError}) and this
 * is where it becomes the verb layer's, so what reaches an agent is the same named
 * `artifact-too-large` refusal `screenshot` raises, carrying both numbers. One wire shape
 * for one fact, whichever end of the transfer noticed it.
 */
async function read(context: VerbContext, devicePath: string): Promise<Uint8Array> {
	try {
		return await context.backend.pullFile(context.serial, devicePath, {
			maxBytes: MAX_ARTIFACT_BYTES,
		});
	} catch (error) {
		if (error instanceof FileTooLargeError) {
			throw new ArtifactTooLargeError(error.serial, error.byteLength, error.maxBytes);
		}
		throw error;
	}
}

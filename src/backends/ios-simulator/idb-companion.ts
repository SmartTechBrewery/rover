/**
 * The `idb_companion` process, held open for as long as it lives — the running half of this
 * backend's second external program, where `./idb-companion-path.ts` is the half that finds it.
 *
 * `spawn`, not `execFile`, and it shares nothing with `./simctl.ts`' query runner: a query is a
 * buffer and an exit code, this is a process whose output only means anything while it is
 * arriving.
 *
 * **Deliberately without a timeout**, which every other invocation in this backend has
 * (ai/CODING_STANDARDS.md). {@link streamSimctlOnDevice}'s stated reason carries over without a
 * change: a timeout exists so a hung program cannot wedge a lease, and the one call that uses
 * this is *supposed* to stay open — so a timeout would guarantee the failure it exists to
 * prevent. What bounds it instead is that nothing downstream may treat its output as
 * authoritative: a lease grant re-verifies the device it is about to lend through `simctl` (D6).
 *
 * **The argv is the caller's; the process is this module's.** `./backend.ts` owns
 * `--notify stdout`, and the per-target companion started with `--udid` belongs to the phase that
 * supervises one of those per target (`docs/IOS.md` §4). What is decided here is the spawn, the
 * handler contract and the kill, so that caller needs no second copy of any of it.
 *
 * **`resolveIdbCompanion()` is let out synchronously**, exactly as {@link streamSimctlOnDevice}
 * lets `SimctlNotFoundError` out. The search is `stat` and `access` and no process
 * (`./idb-companion-path.ts`), so it can answer before this function returns — and a caller that
 * has to tell "there is no companion on this host" apart from "the stream ended" needs it thrown
 * rather than reported as an end, because only one of those two is worth telling an operator
 * about (`./backend.ts`, `watchDevices`).
 *
 * **Killing a companion does not disturb the simulator**, and that is measured rather than
 * assumed: on v1.5.2 the device stayed `Booted` across the companion's exit (`docs/IOS.md` §4).
 * So {@link IdbCompanionStream.stop} is free to kill outright — unlike `./simctl.ts`' recorder,
 * where a kill costs the recording and the device's recording lock with it.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { DEVELOPER_DIR_ENV_VAR, resolveDeveloperDir } from './developer-dir.js';
import { IDB_COMPANION, resolveIdbCompanion } from './idb-companion-path.js';
import { streamOutcome } from './simctl.js';

/**
 * How much of a long-lived companion's stderr a caller keeps for the message it writes when the
 * run ends.
 *
 * The bound lives here and the tail lives in the caller, which is the division
 * {@link SimctlStreamHandlers.onEnd} already draws: this module hands over every byte of both
 * streams and never quotes one back, so whoever puts a stream into a message is who masks and
 * bounds it. Bounded at all because this run lasts as long as the host does, so a companion that
 * chats on stderr for a week would otherwise be a slow leak — and it is the **tail**, because
 * what explains an end is whatever the program said last.
 */
export const IDB_COMPANION_STDERR_TAIL_CHARS = 4096;

/** Handlers of a long-lived run. Each is called as documented on it, and never after `onEnd`. */
export interface IdbCompanionStreamHandlers {
	/**
	 * Raw stdout bytes, in order. **Never decoded here**, unlike `./simctl.ts`' text stream: this
	 * program's framing is one JSON array per line and a chunk boundary can fall inside a
	 * multi-byte character — a simulator whose operator-chosen name is not ASCII — so a frame is
	 * only decoded once all of its bytes are present (`./parsers/idb-notify.ts`).
	 */
	onStdout(chunk: Buffer): void;

	/** Decoded stderr text, in order — a companion's own complaints, whatever it has to say. */
	onStderr(chunk: string): void;

	/**
	 * The run ended, for any reason at all, or never started. Called **exactly once**, and never
	 * after {@link IdbCompanionStream.stop}.
	 *
	 * `reason` is a message ready to be shown to a person: the argv and how it ended. It
	 * deliberately does **not** carry either stream, `./simctl.ts`' rule — the caller has been
	 * handed every byte of both already, and a runner that quoted them back would be deciding for
	 * the caller which half of a failure matters.
	 */
	onEnd(reason: string): void;
}

/** The handle {@link streamIdbCompanion} answers with. */
export interface IdbCompanionStream {
	/**
	 * Kill the companion and resolve once it is gone. No handler is called after `stop()` is
	 * called, and calling it twice is a no-op rather than an error.
	 */
	stop(): Promise<void>;
}

/**
 * Run `idb_companion <args…>` and hand both streams back for as long as it lives.
 *
 * Throws whatever `resolveIdbCompanion()` throws — see the module header for why that is a throw
 * rather than an end.
 *
 * Ends on `close` rather than on `exit`, because `exit` can fire while stdout still holds bytes:
 * a caller that restarts on the end reason would otherwise take delivery of the dead run's last
 * frame after the replacement had already begun.
 *
 * `stdin` is `ignore`d: nothing here has anything to say to a companion, and inheriting it would
 * let one consume the daemon's own input.
 */
export function streamIdbCompanion(
	args: readonly string[],
	handlers: IdbCompanionStreamHandlers,
): IdbCompanionStream {
	const argv = [...args];
	const companion = resolveIdbCompanion();
	const child: ChildProcess = spawn(companion, argv, {
		stdio: ['ignore', 'pipe', 'pipe'],
		env: companionEnvironment(),
	});

	/** Set by the first of `close`/`error`: there is no process left to kill. */
	let ended = false;
	/** Set by the first of `close`/`error` **and** by `stop()`; suppresses every handler call. */
	let finished = false;

	const finish = (reason: string): void => {
		if (finished) return;
		finished = true;
		handlers.onEnd(reason);
	};

	child.stdout?.on('data', (chunk: Buffer) => {
		if (!finished) handlers.onStdout(chunk);
	});
	// Decoded by the stream itself, so a chunk boundary inside a multi-byte character cannot
	// become a replacement character in the message a human reads.
	child.stderr?.setEncoding('utf8');
	child.stderr?.on('data', (chunk: string) => {
		if (!finished) handlers.onStderr(chunk);
	});
	child.on('error', (error: Error) => {
		ended = true;
		// Nothing ran at all: the file the search accepted has moved, or lost its execute bit,
		// since it was verified moments ago.
		finish(`${IDB_COMPANION} ${argv.join(' ')} failed to run: ${error.message}`);
	});
	child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
		ended = true;
		finish(`${IDB_COMPANION} ${argv.join(' ')} ${streamOutcome(code, signal)}`);
	});

	return {
		async stop(): Promise<void> {
			finished = true;
			if (ended) return;

			await new Promise<void>((resolve) => {
				child.once('close', () => resolve());
				child.once('error', () => resolve());
				child.kill();
			});
		},
	};
}

/**
 * This process's environment, with `DEVELOPER_DIR` set to the Xcode this backend's *other*
 * program is run out of.
 *
 * **This is not a convenience, it is #171's rule across two programs**, and it is measured rather
 * than reasoned: on macOS 26.6.2 with `xcode-select` pointing at CommandLineTools — the state
 * `docs/IOS.md` §1 says a developer machine is most likely to be in while looking fully equipped —
 * `idb_companion --notify stdout` exits **0** having printed no frame at all, with *"Failed to
 * resolve the Xcode developer directory. Ensure Xcode is installed and selected with
 * xcode-select"* on stderr, while `simctl` runs perfectly through `./developer-dir.ts`' own search
 * (companion v1.5.2, 2026-09-08). Exporting `DEVELOPER_DIR` is what makes the companion agree, and
 * the frames arrive immediately.
 *
 * So without this, a host Rover can enumerate simulators on is a host whose stream never starts —
 * and worse, a machine where the two *do* resolve differently would have `simctl` driving one
 * Xcode's simulator set while the watch reported the other's, which is the "measuring two
 * machines" failure #171 exists to prevent, one program further out.
 *
 * **The operator's own choice is preserved by construction**: `DEVELOPER_DIR` is the first row of
 * that search, so someone who set it to force a beta's tooling gets their own value handed on.
 *
 * A resolution that fails leaves the environment untouched rather than throwing, and that is the
 * honest order of the two failures: there is no Xcode here at all, so the companion's own message
 * about it is more accurate than one this backend would substitute — and the caller is about to
 * hear from `simctl` in the same terms anyway.
 */
function companionEnvironment(): NodeJS.ProcessEnv {
	try {
		return { ...process.env, [DEVELOPER_DIR_ENV_VAR]: resolveDeveloperDir() };
	} catch {
		return { ...process.env };
	}
}

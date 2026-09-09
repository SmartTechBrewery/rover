/**
 * Fetch the pinned `idb_companion` release and unpack it where the search's last row looks.
 *
 * **Why this exists at all.** Every other program Rover drives has somewhere to come from: `adb`
 * arrives with the Android SDK, `simctl` with Xcode. This one has neither a package manager nor an
 * installer — brew dropped it with the `facebook/fb` tap — so the instruction used to be *unpack a
 * tarball wherever you like, then tell Rover where that was*, which is two decisions before an
 * operator can do anything, and both of them silently wrong more often than not: `~/.local/bin` is
 * on no stock macOS `PATH`, `/usr/local/bin` needs `sudo`, and the variable is read by the
 * **daemon**, which inherits the environment of whichever client woke it (D5) rather than the
 * shell that exported it. Doing the unpacking here removes all of that: the file lands in
 * `~/.rover`, which is the one place both halves already agree on.
 *
 * **On the host, never in a client** (D19). This runs where the simulators are, reached through
 * `install_host_tool`, and `tests/unit/no-backend-in-a-client.test.ts` is what holds the line — a
 * CLI that imported this module would be a client that downloads and spawns.
 *
 * **Pinned, checksummed, and atomic.** The tag is a constant rather than `latest`
 * (`./idb-companion-locations.mjs`), the release's own `.sha256` is fetched and compared before
 * anything is unpacked, and the tree is assembled in a sibling temporary directory and renamed
 * into place — so a download that dies half way leaves nothing a search would accept, and a
 * daemon reading the directory sees either the whole release or none of it.
 *
 * **Idempotent.** A companion the host already has — the operator's own on `PATH`, or a previous
 * run's copy — is a success that says so and downloads nothing. That is what lets `rover doctor
 * --fix` be safe to type twice, and what stops it shadowing a deliberate install: the search order
 * puts Rover's copy last on purpose.
 *
 * **Every step is bounded** (ai/CODING_STANDARDS.md): a hung mirror or a wedged `tar` must not
 * leave the daemon waiting on a request forever, and neither timeout is a sleep — they are
 * deadlines, which is the distinction `src/core/wait.ts` draws.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { isExecutableFile } from '../android/adb-locations.mjs';
import {
	IDB_COMPANION,
	IDB_COMPANION_ARCH,
	IDB_COMPANION_ASSET,
	IDB_COMPANION_VERSION,
	idbCompanionChecksumUrl,
	idbCompanionReleaseUrl,
	managedIdbCompanion,
	managedIdbCompanionDirectory,
} from './idb-companion-locations.mjs';

const execFileAsync = promisify(execFile);

/**
 * How long the two downloads may take.
 *
 * The asset is ~19.5 MB, which is seconds on a working connection and forever on a captive
 * portal that answers with a login page and never closes it. Generous enough for a slow office
 * link, short enough that an operator gets an error rather than a prompt that never returns.
 */
const DOWNLOAD_TIMEOUT_MS = 180_000;

/** How long `tar` may take to unpack it. Local CPU and disk only — a minute is already absurd. */
const UNPACK_TIMEOUT_MS = 60_000;

/** What this host must be for the pinned asset to run on it. */
const SUPPORTED_PLATFORM: NodeJS.Platform = 'darwin';

/** Anything that stopped the install, with a message an operator can act on. */
export class IdbCompanionInstallError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'IdbCompanionInstallError';
	}
}

/** What {@link installIdbCompanion} reads the machine through, so a suite can describe another. */
export interface InstallIdbCompanionOptions {
	readonly home?: string;
	readonly platform?: NodeJS.Platform;
	readonly arch?: string;
	/** The download, injectable so the suite never reaches the network. */
	readonly fetch?: typeof globalThis.fetch;
}

/** Where the companion ended up, and whether this call is what put it there. */
export interface IdbCompanionInstallation {
	readonly path: string;
	readonly version: string;
	readonly installed: boolean;
}

/**
 * Put a runnable `idb_companion` on this host, or say why that could not be done.
 *
 * Answers `installed: false` when the managed copy of this exact version is already unpacked and
 * executable — the caller decides whether an operator's own companion elsewhere on the machine
 * makes even that unnecessary, because only the caller knows the search order
 * (`./host-tooling.ts`).
 */
export async function installIdbCompanion(
	options: InstallIdbCompanionOptions = {},
): Promise<IdbCompanionInstallation> {
	const platform = options.platform ?? process.platform;
	const arch = options.arch ?? process.arch;
	const home = options.home ?? homedir();
	const fetchAsset = options.fetch ?? globalThis.fetch;

	if (platform !== SUPPORTED_PLATFORM) {
		throw new IdbCompanionInstallError(
			`'${IDB_COMPANION}' is macOS-only and this host is '${platform}'. Nothing to install: ` +
				'the iOS-simulator backend finds no devices here either.',
		);
	}
	if (arch !== IDB_COMPANION_ARCH) {
		throw new IdbCompanionInstallError(
			`The idb v${IDB_COMPANION_VERSION} release publishes '${IDB_COMPANION_ASSET}' and nothing ` +
				`for '${arch}', and an ${IDB_COMPANION_ARCH} binary does not run under Rosetta — which ` +
				`translates the other direction. Build '${IDB_COMPANION}' from source and name it with ` +
				'ROVER_IDB_COMPANION_PATH.',
		);
	}

	const target = managedIdbCompanionDirectory(home);
	const companion = managedIdbCompanion(home);
	if (isExecutableFile(companion, platform)) {
		return { path: companion, version: IDB_COMPANION_VERSION, installed: false };
	}

	await mkdir(dirname(target), { recursive: true });
	// Beside the target rather than in the system temporary directory, so the rename below is
	// within one filesystem and therefore atomic: `/tmp` on macOS can be a different volume, and a
	// cross-device rename falls back to a copy that another reader can catch half-written.
	const staging = await mkdtemp(`${target}.incoming-`);
	try {
		const archive = join(staging, IDB_COMPANION_ASSET);
		await writeFile(archive, await downloadVerified(fetchAsset));
		await execFileAsync('tar', ['xzf', archive, '-C', staging], { timeout: UNPACK_TIMEOUT_MS });
		await rm(archive, { force: true });

		const unpacked = join(staging, IDB_COMPANION);
		if (!isExecutableFile(unpacked, platform)) {
			throw new IdbCompanionInstallError(
				`The release unpacked, but no executable '${IDB_COMPANION}' was inside it. The asset's ` +
					'layout has changed and this installer has not caught up.',
			);
		}

		// A leftover from an interrupted earlier attempt is the one thing that can be standing here,
		// since an executable copy returned above. Removing it makes the rename total.
		await rm(target, { recursive: true, force: true });
		await rename(staging, target);
		return { path: companion, version: IDB_COMPANION_VERSION, installed: true };
	} catch (cause) {
		await rm(staging, { recursive: true, force: true });
		throw cause instanceof IdbCompanionInstallError
			? cause
			: new IdbCompanionInstallError(
					`Installing '${IDB_COMPANION}' v${IDB_COMPANION_VERSION} failed: ${messageOf(cause)}`,
				);
	}
}

/**
 * The asset's bytes, checked against the checksum the release publishes beside it.
 *
 * The checksum is fetched from the same release rather than pinned here, which is worth being
 * honest about: it proves the bytes arrived intact and unaltered *in transit*, not that GitHub
 * serves what it served yesterday. Pinning the digest in this repository would give the stronger
 * property, and is the change to make the day the pinned version moves — for now the tag is the
 * pin and this is the transport check.
 */
async function downloadVerified(fetchAsset: typeof globalThis.fetch): Promise<Buffer> {
	const [asset, checksum] = await Promise.all([
		get(fetchAsset, idbCompanionReleaseUrl()),
		get(fetchAsset, idbCompanionChecksumUrl()),
	]);

	const expected = checksum.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase();
	const actual = createHash('sha256').update(asset).digest('hex');
	if (expected === undefined || expected === '') {
		throw new IdbCompanionInstallError(
			`The release's checksum file was empty, so '${IDB_COMPANION_ASSET}' could not be verified.`,
		);
	}
	if (expected !== actual) {
		throw new IdbCompanionInstallError(
			`'${IDB_COMPANION_ASSET}' did not match the checksum the release publishes for it ` +
				`(expected ${expected}, got ${actual}). Nothing was unpacked.`,
		);
	}
	return asset;
}

/** One bounded GET, with a redirect-following default and a status that has to be 2xx. */
async function get(fetchAsset: typeof globalThis.fetch, url: string): Promise<Buffer> {
	const response = await fetchAsset(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
	if (!response.ok) {
		throw new IdbCompanionInstallError(
			`Downloading ${url} answered ${response.status} ${response.statusText}.`,
		);
	}
	return Buffer.from(await response.arrayBuffer());
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

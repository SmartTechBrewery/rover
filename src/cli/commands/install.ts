/**
 * `rover install` — install an application onto the leased device, either from a package on
 * this machine or by running what the lease's project declares.
 *
 * **Two forms, one verb** (D10, `src/verbs/files.ts`). With a `<local-path>` this is `push`'s
 * shape with one path instead of two, and for the reason `install_app` has no device path in
 * its schema at all: the package is on the caller's disk, the install happens on the host, and
 * a path sent along would name a file on the wrong machine — or, worse, one that is on both
 * (D19). What travels is the bytes; the host writes them to a file of its own, installs it
 * pinned to the leased device, and deletes the file in a `finally`. Without one, **nothing
 * travels at all**: the host looks the lease's `project` up in that project's own hook file and
 * runs the `install` it finds there (D13/R17), with the device serial in its environment.
 *
 * No app id in either form, because the core knows no application's name (D13): what gets
 * installed is the package you sent, or whatever the project's own command installs, and which
 * application that is is a fact about the bytes or about the operator's configuration.
 *
 * **Whether the byte-less form is available is the host's answer and never this command's.**
 * A project with no hook file on the host is a `project-not-registered` failure and one whose
 * file declares no `install` is `install-hook-undeclared` — both named, both carrying the
 * serial and the project. So the package stays an *optional positional* rather than a required
 * one this CLI could refuse without asking: a usage error invented here would be this client
 * answering a question only the host can (D16), and it would name the wrong machine's
 * configuration.
 *
 * **Say the uncomfortable part in the usage rather than let it be discovered:** a real
 * application package is routinely tens of megabytes and the cap on one call is 4 MiB, so the
 * byte-carrying form installs a small package today and refuses a large one **by name** —
 * here, before anything is sent. Never a package cut to fit, which would install as a corrupt
 * file or, worse, as a plausible one. Moving a large one means chunked transfer, which lands
 * underneath this verb rather than changing what it promises — which is the other half of why
 * the project form matters: a real project's own install is how a real APK reaches the device
 * today.
 *
 * **The project form raises this client's own request timeout** past the five minutes the host
 * gives that command ({@link INSTALL_HOOK_TIMEOUT_MS}), exactly as `rover record` raises one
 * past the budgets inside a recording. Left at the 30 s default, a build that is merely
 * compiling would surface here as a hang with no name on it while the host was still working
 * and about to say exactly what happened.
 */

import { parseLeaseId } from '../../core/ids.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../../ipc/client.js';
import { type InstallAppParams, MAX_TRANSFER_BYTES } from '../../ipc/methods.js';
import { INSTALL_HOOK_TIMEOUT_MS } from '../../verbs/files.js';
import { expectPositionals, GLOBAL_OPTIONS, parseCommandArgs } from '../_shared/flags.js';
import { connectToHost, resolveHost } from '../_shared/host.js';
import * as out from '../_shared/output.js';
import { deliverTransfer, readPayload, resolveSource } from '../_shared/upload.js';

export const USAGE = `rover install — install an application onto the device

Usage: rover install <lease-id> [<local-path>] [--host <name>] [--json]

  <local-path>  The application package, on the machine running this command. It is read
                here and travels as bytes; the host writes it to a file of its own,
                installs it onto the leased device and deletes that file afterwards.

                Omit it and the host runs what the lease's **project** declares as its
                install instead — a build, a deploy script, whatever that project already
                has — with the leased device's serial in its environment. Nothing travels
                from this machine in that form. A project the host has no hook file for, or
                one whose file declares no install command, is refused by name
                (project-not-registered, install-hook-undeclared) rather than guessed at.

There is no path on the device and no application id: what gets installed is the package you
sent, or whatever the project's own command installs, and Rover never learns its name.

One call carries one whole package, up to ${MAX_TRANSFER_BYTES} bytes. A real application package
is routinely larger than that, so this installs a small one today and refuses a large one by
name, here, before anything is sent — never a package cut to fit, which would install as a
corrupt file or as a plausible one. A source that is missing, cannot be read, or is not a
regular file — a directory, a named pipe, a device — is refused the same way, and in every one
of those cases the host is never asked at all. A pipe is refused rather than sent because its
size says nothing about how much it would send. The project form is the way a package larger
than the cap reaches the device today.

The project form waits out the ${INSTALL_HOOK_TIMEOUT_MS} ms the host allows that command, rather than the
${DEFAULT_REQUEST_TIMEOUT_MS} ms every other command uses — a build that is still compiling is never a hang.

--json reports what the host answered — the device, the state after the install — and never
echoes the bytes back.`;

export async function run(argv: string[]): Promise<number> {
	const { values, positionals } = parseCommandArgs('install', argv, GLOBAL_OPTIONS);
	if (values.help === true) {
		out.info(USAGE);
		return 0;
	}
	const [leaseId, localPath] = expectPositionals(
		'install',
		positionals,
		['<lease-id>'],
		['<local-path>'],
	);
	// Bound and read before `connectToHost`, for `push`'s reason: an over-sized package is
	// refused having sent nothing, rather than after several megabytes are on a socket. The
	// project form skips both, because there is no local file in it to check.
	const sent = localPath === undefined ? undefined : await readSource(localPath);
	const host = resolveHost(values.host);

	const client = await connectToHost(host);
	try {
		const answer = await client.request(
			'install_app',
			// Spread rather than an explicit `undefined`, which is a key on the object:
			// `InstallAppParamsSchema` is `.strict()`, and *which* form this is is exactly what
			// the presence of that key says on the wire.
			{
				leaseId: parseLeaseId(leaseId ?? ''),
				...(sent === undefined ? {} : { packageBase64: sent.packageBase64 }),
			} satisfies InstallAppParams,
			sent === undefined ? { timeoutMs: projectInstallTimeoutMs() } : undefined,
		);
		return deliverTransfer({
			host,
			answer,
			json: values.json === true,
			// The source path is this machine's own and is printed as typed, the way `--out` is:
			// it is the one path in the sentence that means something where it is read. The
			// project form has no such path — what ran is host-side configuration, and naming a
			// command this machine never saw would be inventing one.
			describe: (result) =>
				sent === undefined
					? `Installed onto ${result.device.serial} by running what the lease's project ` +
						`declares as its install`
					: `Installed ${Buffer.byteLength(sent.packageBase64, 'base64')} bytes from ` +
						`${sent.source} onto ${result.device.serial}`,
		});
	} finally {
		await client.close();
	}
}

/** The package this machine is sending: where it was read from, and its bytes as they travel. */
async function readSource(
	localPath: string,
): Promise<{ readonly source: string; readonly packageBase64: string }> {
	const source = await resolveSource('install', localPath);
	return { source, packageBase64: await readPayload('install', source) };
}

/**
 * How long this client waits for a project's own install: the budget the host gives that
 * command, plus the budget every other call gets for the round trip.
 *
 * `rover record`'s `requestTimeoutFor` pattern, and both terms are **imported** rather than
 * restated — the promise only holds while this bound is larger than the bound inside it, and a
 * copied number is one the original is free to drift away from. There is no knob to read here
 * because the caller does not set the budget: the host's own
 * {@link INSTALL_HOOK_TIMEOUT_MS} is the whole of it.
 */
function projectInstallTimeoutMs(): number {
	return INSTALL_HOOK_TIMEOUT_MS + DEFAULT_REQUEST_TIMEOUT_MS;
}

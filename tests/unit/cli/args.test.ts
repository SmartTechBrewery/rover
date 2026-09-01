/**
 * Dispatch and flag parsing, with no host anywhere in it.
 *
 * Every case here has to be decided **before** a connection is attempted — that is half of
 * what is being asserted. So the socket path is stubbed at a temp directory nobody serves,
 * and `afterEach` fails if anything turned up on it: a command that reached
 * `connectToHost()` would autostart a real daemon, and a test that quietly tolerated one
 * would also tolerate `--host somewhere-else` spawning a local daemon before rejecting the
 * name.
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST, REMOTE_HOST, resolveHost } from '@/cli/_shared/host.js';
import { EXIT_OK, EXIT_USAGE, run } from '@/cli/index.js';
import { PROJECT_FILE_ENV_VAR } from '@/daemon/project-hooks.js';
import { ATTRIBUTION_MAX_LENGTH, AttributionStringSchema } from '@/ipc/methods.js';
import { MAX_FRAMES_PER_SECOND, MAX_RECORDING_MS } from '@/verbs/record.js';
import {
	connectWithoutStarting,
	createTempSocket,
	removeTempSocket,
	stopDaemonAt,
	type TempSocket,
} from '../../helpers/daemon-socket.js';

let temp: TempSocket;
let logged: string[];
let errored: string[];

beforeEach(async () => {
	temp = await createTempSocket();
	vi.stubEnv('ROVER_SOCKET_PATH', temp.socketPath);
	// Stubbed empty for every test so a developer's own exported hook file cannot decide
	// whether `--project` is required in here.
	vi.stubEnv(PROJECT_FILE_ENV_VAR, '');
	logged = [];
	errored = [];
	vi.spyOn(console, 'log').mockImplementation((line: string) => logged.push(line));
	vi.spyOn(console, 'warn').mockImplementation((line: string) => errored.push(line));
	vi.spyOn(console, 'error').mockImplementation((line: string) => errored.push(line));
});

afterEach(async () => {
	vi.restoreAllMocks();
	const stray = await connectWithoutStarting(temp.socketPath);
	if (stray) {
		await stray.close();
		await stopDaemonAt(temp.socketPath);
	}
	await removeTempSocket(temp);
	expect(stray).toBeNull();
});

describe('rover, before it talks to anything', () => {
	it('prints usage on stdout and exits 0 for --help', async () => {
		expect(await run(['--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Usage: rover <command> [options]');
		expect(errored).toEqual([]);
	});

	it('prints usage on stdout and exits 0 for no command at all', async () => {
		expect(await run([])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Commands:');
	});

	it('exits 2 with usage on stderr for an unknown command', async () => {
		expect(await run(['tap'])).toBe(EXIT_USAGE);

		// Both on stderr: stdout stays empty so a caller reading it never sees usage text
		// where a result belongs.
		expect(errored.join('\n')).toContain("Unknown command 'tap'");
		expect(errored.join('\n')).toContain('Usage: rover <command> [options]');
		expect(logged).toEqual([]);
	});

	// An object literal inherits these from Object.prototype, so a dispatch table built as one
	// hands every one of them back as a truthy value — past the unknown-command guard and into
	// `handler.run`, where the TypeError surfaces as exit 1: "the operation did not succeed",
	// for a word that was never a command.
	it.each([
		'toString',
		'valueOf',
		'constructor',
		'hasOwnProperty',
		'__proto__',
	])("exits 2 with usage for '%s', an inherited key and not a command", async (inherited) => {
		expect(await run([inherited])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain(`Unknown command '${inherited}'`);
		expect(errored.join('\n')).toContain('Usage: rover <command> [options]');
		expect(logged).toEqual([]);
	});

	it("exits 2 for a command's unknown flag", async () => {
		expect(await run(['list', '--evrything'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--evrything');
	});

	it('exits 2 for an argument a command does not take', async () => {
		expect(await run(['status', 'local'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected no arguments');
	});

	it('names both hosts and exits 2 for one that is neither', async () => {
		expect(await run(['list', '--host', 'somewhere-else'])).toBe(EXIT_USAGE);

		const said = errored.join('\n');
		expect(said).toContain("Unknown host 'somewhere-else'");
		// The failure has to say what the reachable hosts *are*, or the flag reads as broken
		// rather than as mistyped — and for 'remote' that means naming what configures it.
		expect(said).toContain("'local'");
		expect(said).toContain("'remote'");
		expect(said).toContain('ROVER_HOST_ADDRESS');
		// The rejecting command's own usage, not the dispatcher's: the shape the caller got
		// wrong is what they need back.
		expect(said).toContain('Usage: rover list');
	});

	it('treats --host local and no flag as the same host', () => {
		// Asserted on the seam rather than through a command, because the alternative is a
		// command that connects — and 'local' resolving is exactly the case that would then
		// autostart a daemon in a suite that has no business starting one.
		expect(resolveHost('local')).toBe(LOCAL_HOST);
		expect(resolveHost(undefined)).toBe(LOCAL_HOST);
	});

	it('resolves --host remote without connecting to anything', () => {
		// Same reason as above, mirrored: resolving the *name* is a pure decision, and it has
		// to stay one — a `resolveHost` that reached for the environment or a socket would
		// make every flag-parsing test depend on what the developer exported.
		expect(resolveHost('remote')).toBe(REMOTE_HOST);
	});

	it("prints a command's own usage for `<command> --help`", async () => {
		expect(await run(['list', '--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain('Usage: rover list');
	});
});

describe('rover acquire, on its required attribution', () => {
	it('exits 2 without --owner rather than deriving one', async () => {
		expect(await run(['acquire', 'serial-1', '--project', 'rover'])).toBe(EXIT_USAGE);

		// The message has to say the value is the caller's to supply (D16, D20). A CLI that
		// filled it in from the environment would be the failure those decisions prevent.
		expect(errored.join('\n')).toContain('--owner is required');
	});

	it('exits 2 without --project', async () => {
		expect(await run(['acquire', 'serial-1', '--owner', 'issue-112'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--project is required');
	});

	it('exits 2 without a serial', async () => {
		expect(await run(['acquire', '--owner', 'issue-112', '--project', 'rover'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected <serial>');
	});

	it('exits 2 for an --owner given as an empty string', async () => {
		expect(await run(['acquire', 'serial-1', '--owner', '', '--project', 'rover'])).toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('--owner is required');
	});

	// The third attribution string has to fail the same way the other two do. Left to the host it
	// is a round trip that comes back naming `testName` — a key the caller never typed — at exit
	// 1, the code reserved for a refused acquire or an unreachable host.
	it('exits 2 for a --test-name given with no value, without reaching a host', async () => {
		expect(
			await run([
				'acquire',
				'serial-1',
				'--owner',
				'issue-112',
				'--project',
				'rover',
				'--test-name',
				'',
			]),
		).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--test-name is required');
		expect(errored.join('\n')).toContain('Usage: rover acquire');
	});

	// The CLI surfaces the requirement itself rather than sending an absent field and letting
	// the host answer `invalid_params` at exit 1 (D22, as amended #129). Unlike `--project`,
	// nothing stands in for it — there is no file to fall back on.
	it('exits 2 for a missing --test-name, without reaching a host', async () => {
		expect(await run(['acquire', 'serial-1', '--owner', 'issue-112', '--project', 'rover'])).toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('--test-name is required');
		expect(errored.join('\n')).toContain('Usage: rover acquire');
	});

	it.each([
		'owner',
		'project',
		'test-name',
	])('exits 2 for a --%s past the length the host accepts, naming the flag as typed', async (flag) => {
		const argv = [
			'acquire',
			'serial-1',
			'--owner',
			'issue-112',
			'--project',
			'rover',
			'--test-name',
			'home screen',
		];
		const tooLong = 'x'.repeat(ATTRIBUTION_MAX_LENGTH + 1);
		const at = argv.indexOf(`--${flag}`);
		if (at === -1) {
			argv.push(`--${flag}`, tooLong);
		} else {
			argv[at + 1] = tooLong;
		}

		expect(await run(argv)).toBe(EXIT_USAGE);

		// The flag as the caller spelled it, not the request key it maps to.
		expect(errored.join('\n')).toContain(`--${flag} is ${tooLong.length} characters`);
		expect(errored.join('\n')).not.toContain('testName');
	});

	it('names the variable that can supply --project in its own usage text', async () => {
		expect(await run(['acquire', '--help'])).toBe(EXIT_OK);

		// Where a defaulted project came from has to be readable from the command itself; a
		// caller who never typed one otherwise has to guess what the lease was attributed to.
		expect(logged.join('\n')).toContain(PROJECT_FILE_ENV_VAR);
	});

	it('exits 2 naming the path when the configured hook file is not there', async () => {
		const missing = join(temp.dir, 'nothing-here.json');
		vi.stubEnv(PROJECT_FILE_ENV_VAR, missing);

		expect(await run(['acquire', 'serial-1', '--owner', 'issue-112'])).toBe(EXIT_USAGE);

		// Never a silent fallback to "no default": a lease attributed to nothing is the failure
		// D20 and D22 exist to prevent, so the path and the variable are both in the message.
		expect(errored.join('\n')).toContain(missing);
		expect(errored.join('\n')).toContain(PROJECT_FILE_ENV_VAR);
	});

	it('refuses a configured file that is not there even when --project was typed', async () => {
		const missing = join(temp.dir, 'nothing-here.json');
		vi.stubEnv(PROJECT_FILE_ENV_VAR, missing);

		// The flag wins on the *value*, but a broken configuration that only surfaced on the
		// invocations where somebody happened to leave the flag off would be intermittent.
		expect(await run(['acquire', 'serial-1', '--owner', 'issue-112', '--project', 'rover'])).toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain(missing);
	});

	it('exits 2 for a --project given as an empty string, file configured or not', async () => {
		const path = join(temp.dir, 'checkout-web.json');
		await writeFile(path, JSON.stringify({ project: 'checkout-web' }), 'utf8');
		vi.stubEnv(PROJECT_FILE_ENV_VAR, path);

		// A flag typed with nothing after it is a mistake, and answering it with a value the
		// caller did not type would hide the mistake behind a lease that looks fine.
		expect(await run(['acquire', 'serial-1', '--owner', 'issue-112', '--project', ''])).toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('--project is required');
	});

	it('takes its ceiling from the host schema rather than restating it', () => {
		// One bound, in one place. A CLI carrying its own copy would start refusing values the
		// host accepts — or waving through ones it does not — the moment the schema moves.
		expect(() => AttributionStringSchema.parse('x'.repeat(ATTRIBUTION_MAX_LENGTH))).not.toThrow();
		expect(() => AttributionStringSchema.parse('x'.repeat(ATTRIBUTION_MAX_LENGTH + 1))).toThrow();
	});
});

describe('rover screenshot and rover record, on --out, --duration-ms and --frames-per-second', () => {
	// Every case in here has to be decided before a connection, like the rest of this file:
	// a capture spends a lease-renewing round trip and several megabytes, and reporting a
	// mistyped flag afterwards would spend all of it to say something knowable up front.
	it.each([
		'screenshot',
		'record',
	])('exits 2 without --out rather than inventing a filename for %s', async (command) => {
		expect(await run([command, 'lease-1'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--out is required');
		expect(errored.join('\n')).toContain(`Usage: rover ${command}`);
	});

	it.each(['screenshot', 'record'])('exits 2 without a lease id for %s', async (command) => {
		expect(await run([command, '--out', 'somewhere.bin'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected <lease-id>');
	});

	it('exits 2 for a --duration-ms that is not a whole number of milliseconds', async () => {
		expect(await run(['record', 'lease-1', '--out', 'out.mp4', '--duration-ms', 'a while'])).toBe(
			EXIT_USAGE,
		);

		expect(errored.join('\n')).toContain('--duration-ms');
	});

	it('exits 2 for a --duration-ms past what one answer can carry, naming the bound', async () => {
		// The bound is the verb's own, imported rather than restated, so the two cannot drift.
		// Left to the host this is a round trip that comes back `invalid_params` at exit 1 —
		// the code this CLI reserves for a refused verb or an unreachable host.
		expect(
			await run([
				'record',
				'lease-1',
				'--out',
				'out.mp4',
				'--duration-ms',
				String(MAX_RECORDING_MS + 1),
			]),
		).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain(`${MAX_RECORDING_MS} ms`);
	});

	it('exits 2 for a --frames-per-second that is not a whole number of frames', async () => {
		expect(
			await run(['record', 'lease-1', '--out', 'out.mp4', '--frames-per-second', 'lots']),
		).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--frames-per-second');
	});

	it('exits 2 for a --frames-per-second past the densest sampling, naming the bound', async () => {
		// `--duration-ms`'s reasoning, applied to the verb's second knob: the rate is bounded on
		// the wire too, but reaching that costs a connection, a lease renewal and a round trip to
		// be told at exit 1 what this end already knew.
		expect(
			await run([
				'record',
				'lease-1',
				'--out',
				'out.mp4',
				'--frames-per-second',
				String(MAX_FRAMES_PER_SECOND + 1),
			]),
		).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain(String(MAX_FRAMES_PER_SECOND));
	});

	it('exits 2 for a screenshot flag that does not exist', async () => {
		expect(await run(['screenshot', 'lease-1', '--destination', 'out.png'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--destination');
	});

	it.each([
		'screenshot',
		'record',
	])("prints %s's own usage for --help, and asks no host", async (command) => {
		expect(await run([command, '--help'])).toBe(EXIT_OK);

		expect(logged.join('\n')).toContain(`Usage: rover ${command}`);
		expect(errored).toEqual([]);
	});
});

describe('rover install, whose package argument is optional', () => {
	it('exits 2 without a lease id, naming the optional half as optional', async () => {
		expect(await run(['install'])).toBe(EXIT_USAGE);

		// The shape in the message is what tells a caller the package may be left off — which is
		// the whole point of the byte-less form, and unreadable from a message that spelled both
		// positionals as required.
		expect(errored.join('\n')).toContain('expected <lease-id> [<local-path>]');
	});

	it('exits 2 on a third positional rather than ignoring it', async () => {
		expect(await run(['install', 'lease-1', './app.apk', '/data/local/tmp/app.apk'])).toBe(
			EXIT_USAGE,
		);

		// `install` has no device path — that is `push` — and a silently dropped argument is a
		// caller who thinks they said where the package should land.
		expect(errored.join('\n')).toContain('expected <lease-id> [<local-path>]');
	});
});

describe('rover force-release, on its serial and its actor', () => {
	it('exits 2 without a serial', async () => {
		expect(await run(['force-release', '--actor', 'karolina'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected <serial>');
	});

	it('exits 2 without --actor rather than deriving one', async () => {
		expect(await run(['force-release', 'serial-1'])).toBe(EXIT_USAGE);

		// The record of who ended somebody else's lease is the caller's to supply (D20, D28). A
		// CLI that filled it in from the environment would attribute the action to nobody.
		expect(errored.join('\n')).toContain('--actor is required');
		expect(errored.join('\n')).toContain('Usage: rover force-release');
	});

	it('exits 2 for an --actor given as an empty string', async () => {
		expect(await run(['force-release', 'serial-1', '--actor', ''])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--actor is required');
	});

	it('takes no --lease-id: there is no credential to present', async () => {
		expect(
			await run(['force-release', 'serial-1', '--actor', 'karolina', '--lease-id', 'lease-1']),
		).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--lease-id');
	});
});

describe('rover release, on its one argument', () => {
	it('exits 2 without a lease id', async () => {
		expect(await run(['release'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('expected <lease-id>');
	});

	it('takes no --owner: the lease id is the credential', async () => {
		expect(await run(['release', 'lease-1', '--owner', 'issue-112'])).toBe(EXIT_USAGE);

		expect(errored.join('\n')).toContain('--owner');
	});
});

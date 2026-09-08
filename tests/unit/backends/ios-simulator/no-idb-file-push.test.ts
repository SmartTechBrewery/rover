import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IDB_RPCS } from '@/backends/ios-simulator/idb-client.js';
import { stripComments } from '../../../helpers/no-sleep-scan.js';

/**
 * **Rover never calls idb's file-push RPC**, as an executable gate — the family
 * `tests/unit/no-sleep.test.ts` and the panel scans belong to.
 *
 * It is worth a gate rather than a comment because of what breaking it costs. On companion v1.5.2
 * a file push crashes the whole process, deterministically, at exit 133 / SIGTRAP with
 * *"NIOThrowingAsyncSequenceProducer allows only a single AsyncIterator to be created"* — and it
 * takes **every other in-flight call for that device** down with it (`docs/IOS.md` §4, reproduced
 * twice). So the damage is not confined to the caller who tried it: a screen read and an input
 * happening at the same moment on the same device die too. A simulator's storage is a directory on
 * this host, so `pushFile` copies a file and reaches no companion at all (#228,
 * `src/backends/ios-simulator/containers.ts`), and that must stay true.
 *
 * Three checks, because one regex would be a floor and this rule can afford better:
 *
 * 1. The RPC is really called what this file scans for — read out of the **vendored proto**, so
 *    the gate cannot go on passing because a newer idb renamed it.
 * 2. It is not on {@link IDB_RPCS}, the closed list the client's call surface is typed from. That
 *    is the half a compiler enforces.
 * 3. Nothing that can reach a companion names it. The scan set is `idb-client.ts` plus every
 *    `src/` file that imports it — which is what makes this precise rather than a grep for a word
 *    that is also `Array.prototype.push`, `adb push` and this repository's own `push` verb.
 *
 * Comments are blanked first: the most valuable paragraphs about this rule are the ones that name
 * the RPC in order to forbid it, and a gate its own documentation cannot survive is one somebody
 * deletes.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SRC = 'src';
const IDB_CLIENT = 'src/backends/ios-simulator/idb-client.ts';
const IDB_PROTO = 'src/backends/ios-simulator/idb/idb.proto';

/** idb's own name for it, `rpc push(stream PushRequest) returns (PushResponse)`. */
const FILE_PUSH_RPC = 'push';

/** How the module that owns the channel is imported, by either spelling this repository allows. */
const IMPORTS_IDB_CLIENT = /from '(?:\.\/|@\/backends\/ios-simulator\/)idb-client\.js'/;

function read(relative: string): string {
	return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

function sourceFiles(): string[] {
	return readdirSync(path.join(REPO_ROOT, SRC), { withFileTypes: true, recursive: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
		.map((entry) => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)));
}

/** Every file that holds a companion channel, or could get one from the module that does. */
function filesThatCanReachACompanion(): string[] {
	return sourceFiles().filter((file) => file === IDB_CLIENT || IMPORTS_IDB_CLIENT.test(read(file)));
}

/** Where `name` appears as a quoted string — the only way an RPC is named through that surface. */
function namesAsString(source: string, name: string): boolean {
	return new RegExp(`['"\`]${name}['"\`]`).test(stripComments(source));
}

describe('nothing in this repository pushes a file through idb', () => {
	it('scans the RPC under the name the vendored proto gives it', () => {
		expect(read(IDB_PROTO)).toMatch(new RegExp(`^\\s*rpc ${FILE_PUSH_RPC}\\(`, 'm'));
	});

	it('leaves it off the closed list of RPCs the client may be asked for', () => {
		expect([...IDB_RPCS]).not.toContain(FILE_PUSH_RPC);
	});

	it('names it in no file that can reach a companion', () => {
		const offences = filesThatCanReachACompanion().filter((file) =>
			namesAsString(read(file), FILE_PUSH_RPC),
		);

		expect(offences).toEqual([]);
	});

	/**
	 * The scan set is only meaningful while the channel stays in one module: a second file that
	 * built its own client would be outside every check above. So the gate also fixes *who* may
	 * hold one, which is the same tripwire shape as `remote-never-spawns.test.ts`' spawn list.
	 */
	it('lets exactly one module hold a companion channel', () => {
		const holders = sourceFiles().filter((file) => /from '@grpc\//.test(read(file)));

		expect(holders).toEqual([IDB_CLIENT]);
	});

	it('scans something, so a broken walk cannot pass silently', () => {
		expect(sourceFiles().length).toBeGreaterThan(10);
		expect(filesThatCanReachACompanion()).toContain(IDB_CLIENT);
	});

	/**
	 * And the scan itself works — proved against a line nobody would write, because a gate whose
	 * regex quietly stopped matching is indistinguishable from a repository that obeys it.
	 */
	it('would catch the call if somebody made it', () => {
		expect(
			namesAsString(`await companions.call(serial, '${FILE_PUSH_RPC}', {});`, FILE_PUSH_RPC),
		).toBe(true);
		expect(namesAsString(`// never call '${FILE_PUSH_RPC}'`, FILE_PUSH_RPC)).toBe(false);
	});
});

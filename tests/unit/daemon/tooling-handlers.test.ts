import { describe, expect, it } from 'vitest';
import type { HostTooling } from '@/backends/manifest.js';
import { parsePlatformId } from '@/core/ids.js';
import { createToolingHandlers } from '@/daemon/tooling-handlers.js';

/**
 * The two host-tooling handlers, with the registry replaced.
 *
 * Nothing here registers a backend or touches a filesystem: what these cases are about is the
 * surface — that a report is passed through unchanged, that a refusal arrives as data rather than
 * as a thrown transport error, and that every install writes the audit line D28 requires.
 */

const platform = parsePlatformId('ios-simulator');

function tooling(overrides: Partial<HostTooling> = {}): HostTooling {
	return {
		platform,
		tool: 'idb_companion',
		found: '/home/.rover/idb-companion-1.5.2/idb_companion',
		detail: 'Installed v1.5.2 at /home/.rover/idb-companion-1.5.2/idb_companion.',
		installable: true,
		...overrides,
	};
}

describe('list_host_tooling', () => {
	it('answers with every row the registry reported, unchanged', async () => {
		const handlers = createToolingHandlers({ describe: async () => [tooling()] });

		await expect(handlers.list_host_tooling({})).resolves.toEqual({ tools: [tooling()] });
	});

	/** A host with no backend registered is a legitimate answer, not an error. */
	it('answers with an empty list when no backend reported anything', async () => {
		const handlers = createToolingHandlers({ describe: async () => [] });

		await expect(handlers.list_host_tooling({})).resolves.toEqual({ tools: [] });
	});
});

describe('install_host_tool', () => {
	it('answers installed, and writes one audit line naming who asked', async () => {
		const audit: string[] = [];
		const handlers = createToolingHandlers({
			install: async () => tooling(),
			audit: (message) => audit.push(message),
		});

		const result = await handlers.install_host_tool({ tool: 'idb_companion', actor: 'jkwiecien' });

		expect(result.outcome).toBe('installed');
		expect(audit).toHaveLength(1);
		expect(audit[0]).toContain('idb_companion');
		expect(audit[0]).toContain('"jkwiecien"');
	});

	/**
	 * Whether bytes were fetched is the provider's to say, and it says it in `detail` — read here
	 * rather than tracked separately, so the two cannot come to disagree.
	 */
	it('answers already-present when the host already had it', async () => {
		const handlers = createToolingHandlers({
			install: async () => tooling({ detail: 'Already installed at /home/x; nothing downloaded.' }),
			audit: () => {},
		});

		const result = await handlers.install_host_tool({ tool: 'idb_companion', actor: 'jkwiecien' });

		expect(result.outcome).toBe('already-present');
	});

	/**
	 * An Intel mac, a release whose layout moved, a name no backend offers: each is an answer to
	 * the question rather than a failure to answer it, so it comes back as a sentence the caller
	 * can print instead of an `internal_error`.
	 */
	it('answers refused with the reason, rather than throwing', async () => {
		const audit: string[] = [];
		const handlers = createToolingHandlers({
			install: async () => {
				throw new Error('this host is x64 and the release is arm64');
			},
			audit: (message) => audit.push(message),
		});

		const result = await handlers.install_host_tool({ tool: 'idb_companion', actor: 'jkwiecien' });

		expect(result).toEqual({
			outcome: 'refused',
			tool: 'idb_companion',
			message: 'this host is x64 and the release is arm64',
		});
		expect(audit[0]).toContain('Refused');
	});

	/**
	 * A newline in the actor would otherwise end the audit line and start a fabricated one in the
	 * daemon's own record — `kept-tests-handlers.ts`' reason for the same `JSON.stringify`.
	 */
	it('quotes the actor, so a newline in it cannot forge a second line', async () => {
		const audit: string[] = [];
		const handlers = createToolingHandlers({
			install: async () => tooling(),
			audit: (message) => audit.push(message),
		});

		await handlers.install_host_tool({ tool: 'idb_companion', actor: 'ci\nInstalled everything' });

		expect(audit[0]).toContain('"ci\\nInstalled everything"');
		expect(audit[0]?.split('\n')).toHaveLength(1);
	});
});

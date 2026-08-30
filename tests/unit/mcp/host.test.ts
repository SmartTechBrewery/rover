/**
 * Which host the server asks, and when it finds out.
 *
 * `ROVER_HOST_ADDRESS` set means the remote host, unset means the local daemon (D17), and the
 * whole configuration is resolved **at startup** — before a transport is connected — so a
 * half-configured server dies naming what is missing instead of advertising four tools and
 * failing at the agent's first call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST, REMOTE_HOST } from '@/daemon/host.js';
import {
	HOST_ADDRESS_ENV_VAR,
	HOST_PORT_ENV_VAR,
	HOST_TOKEN_ENV_VAR,
} from '@/daemon/network-config.js';
import { resolveConfiguredHost } from '@/mcp/_shared/host.js';

const A_TOKEN = 'x'.repeat(43);

beforeEach(() => {
	for (const variable of [HOST_ADDRESS_ENV_VAR, HOST_PORT_ENV_VAR, HOST_TOKEN_ENV_VAR]) {
		vi.stubEnv(variable, '');
	}
});

describe('the host an MCP server was configured for', () => {
	it('is the local daemon when nothing names a remote one', () => {
		expect(resolveConfiguredHost(process.env)).toBe(LOCAL_HOST);
	});

	it('treats an exported-but-blank address as unset, the way a shell leaves one behind', () => {
		expect(resolveConfiguredHost({ [HOST_ADDRESS_ENV_VAR]: '' })).toBe(LOCAL_HOST);
	});

	it('is the remote host when the environment names one', () => {
		expect(
			resolveConfiguredHost({
				[HOST_ADDRESS_ENV_VAR]: '10.0.0.4',
				[HOST_PORT_ENV_VAR]: '7333',
				[HOST_TOKEN_ENV_VAR]: A_TOKEN,
			}),
		).toBe(REMOTE_HOST);
	});

	it('throws at startup, naming every missing variable, when the remote host is half there', () => {
		// One pass, not two: an operator who set the address and neither of the rest is told
		// about both, and is told now rather than through a failed tool call later.
		expect(() => resolveConfiguredHost({ [HOST_ADDRESS_ENV_VAR]: '10.0.0.4' })).toThrow(
			new RegExp(`${HOST_PORT_ENV_VAR}[\\s\\S]*${HOST_TOKEN_ENV_VAR}`),
		);
	});

	it('throws for a token too short to be the one a host issued', () => {
		expect(() =>
			resolveConfiguredHost({
				[HOST_ADDRESS_ENV_VAR]: '10.0.0.4',
				[HOST_PORT_ENV_VAR]: '7333',
				[HOST_TOKEN_ENV_VAR]: 'too-short',
			}),
		).toThrow(HOST_TOKEN_ENV_VAR);
	});

	it('never quotes the token it rejected, so a startup failure cannot leak a credential', () => {
		let said = '';
		try {
			resolveConfiguredHost({
				[HOST_ADDRESS_ENV_VAR]: '10.0.0.4',
				[HOST_PORT_ENV_VAR]: '7333',
				[HOST_TOKEN_ENV_VAR]: 'short-secret',
			});
		} catch (error) {
			said = error instanceof Error ? error.message : String(error);
		}

		expect(said).not.toBe('');
		expect(said).not.toContain('short-secret');
	});
});

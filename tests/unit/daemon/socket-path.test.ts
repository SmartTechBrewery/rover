import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	MAX_SOCKET_PATH_BYTES,
	resolveSocketPath,
	SOCKET_PATH_ENV_VAR,
} from '@/daemon/socket-path.js';

const DEFAULT_PATH = join(homedir(), '.rover', 'rover.sock');

describe('resolveSocketPath', () => {
	it('prefers the configured path', () => {
		expect(resolveSocketPath({ [SOCKET_PATH_ENV_VAR]: '/tmp/rover-configured.sock' })).toBe(
			'/tmp/rover-configured.sock',
		);
	});

	it('reads process.env when no environment is passed', () => {
		vi.stubEnv(SOCKET_PATH_ENV_VAR, '/tmp/rover-from-process-env.sock');

		expect(resolveSocketPath()).toBe('/tmp/rover-from-process-env.sock');
	});

	it('falls back to ~/.rover/rover.sock when unset', () => {
		expect(resolveSocketPath({})).toBe(DEFAULT_PATH);
	});

	it('treats an exported-but-empty value as unset', () => {
		expect(resolveSocketPath({ [SOCKET_PATH_ENV_VAR]: '' })).toBe(DEFAULT_PATH);
	});

	it('accepts a path exactly at the address limit', () => {
		const atLimit = `/tmp/${'r'.repeat(MAX_SOCKET_PATH_BYTES - '/tmp/'.length)}`;
		expect(Buffer.byteLength(atLimit, 'utf8')).toBe(MAX_SOCKET_PATH_BYTES);

		expect(resolveSocketPath({ [SOCKET_PATH_ENV_VAR]: atLimit })).toBe(atLimit);
	});

	it('rejects an over-long path, naming the limit and the offending path', () => {
		const tooLong = `/tmp/${'r'.repeat(MAX_SOCKET_PATH_BYTES)}.sock`;

		// The failure this replaces is a bare EINVAL out of `bind`, which names neither.
		expect(() => resolveSocketPath({ [SOCKET_PATH_ENV_VAR]: tooLong })).toThrow(
			`${MAX_SOCKET_PATH_BYTES}-byte limit`,
		);
		expect(() => resolveSocketPath({ [SOCKET_PATH_ENV_VAR]: tooLong })).toThrow(tooLong);
	});

	it('counts bytes rather than characters', () => {
		// A path that fits in 103 UTF-16 code units and does not fit in 103 bytes is the case
		// a `length` check gets wrong, and it fails at `bind` rather than here.
		const multiByte = `/tmp/${'ż'.repeat(60)}`;
		expect(multiByte.length).toBeLessThan(MAX_SOCKET_PATH_BYTES);

		expect(() => resolveSocketPath({ [SOCKET_PATH_ENV_VAR]: multiByte })).toThrow(
			`${MAX_SOCKET_PATH_BYTES}-byte limit`,
		);
	});
});

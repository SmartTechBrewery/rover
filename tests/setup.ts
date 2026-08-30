// Global Vitest setup, loaded before every test file (see vitest.config.ts).
// Mirrors Swarm's tests/setup.ts.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACTS_PATH_ENV_VAR } from '@/daemon/archive-path.js';

/**
 * **No test ever writes to `~/.rover/artifacts`** (ai/TESTING.md).
 *
 * The socket and the user store are pointed at a temp path per suite, because each suite
 * has to know where its own is. The archive is different: a suite that starts a daemon
 * in-process passes `artifactsRoot` explicitly and never reads this, while a suite that
 * *spawns* one gets a child that inherits this process's environment and resolves the root
 * itself (`src/daemon/main.ts`). So the floor is set here, once, rather than in each of the
 * suites that happens to spawn — a daemon started by a test that later grows an artifact
 * verb must not start filing into the developer's own durable tree.
 *
 * A fixed path under the OS temp directory rather than a fresh `mkdtemp`: nothing is
 * expected to be written here at all, and a per-file directory nobody removes would
 * accumulate.
 */
process.env[ARTIFACTS_PATH_ENV_VAR] = join(tmpdir(), 'rover-test-artifacts');

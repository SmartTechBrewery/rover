// Global Vitest setup, loaded before every test file (see vitest.config.ts).
// Mirrors Swarm's tests/setup.ts.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACTS_PATH_ENV_VAR } from '@/daemon/archive-path.js';
import { KEPT_TESTS_PATH_ENV_VAR } from '@/daemon/kept-tests.js';

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
 *
 * **A spawned daemon now sweeps whatever it finds here as it comes up** (`PROJECT.md` D38,
 * `src/daemon/retention-schedule.ts`), by the shipped budget and the shipped thirty days. That is
 * the intended consequence of the floor rather than a hazard of it: this directory is the one
 * nothing is expected to write to, so the worst it can cost is a run some earlier suite left
 * behind — and the alternative, an unswept tree the developer's own daemon would sweep, is the
 * divergence between a test host and a real one that this file exists to prevent.
 */
process.env[ARTIFACTS_PATH_ENV_VAR] = join(tmpdir(), 'rover-test-artifacts');

/**
 * **And no test ever writes to `~/.rover/kept-tests.json`** — the host's own record of which
 * archived tests the operator keeps (`PROJECT.md` D33).
 *
 * The floor is set here for the artifact root's exact reason, and it matters rather more: this is
 * the one piece of host state a *call* writes, so a daemon a test **spawns** — which resolves the
 * path from the environment it inherits (`src/daemon/main.ts`) — would not merely read the
 * developer's own file but rewrite it. A suite that starts a daemon in-process passes
 * `keptTestsPath` explicitly and never reads this.
 */
process.env[KEPT_TESTS_PATH_ENV_VAR] = join(tmpdir(), 'rover-test-kept-tests.json');

import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirror Swarm's `@/*` → `src/*` alias so imports resolve the same way tsc does. The panel
// deliberately gets a *different* prefix (`@panel/*` → `panel/src/*`, panel/tsconfig.json) so
// one alias never means two trees; this one is repo-wide and would otherwise reach into the
// panel project too.
const resolve = {
	alias: [
		{ find: '@panel', replacement: path.resolve(__dirname, './panel/src') },
		{ find: '@', replacement: path.resolve(__dirname, './src') },
	],
};

const sharedTest = {
	globals: true,
	environment: 'node' as const,
	clearMocks: true,
	unstubEnvs: true,
	setupFiles: ['./tests/setup.ts'],
};

export default defineConfig({
	test: {
		// Both projects may legitimately run zero tests: the tree has no tests yet, and the
		// device suites skip themselves when no device is attached (tests/device/setup.ts).
		passWithNoTests: true,

		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.test.ts'],
					pool: 'threads',
					...sharedTest,
				},
				resolve,
			},
			// The panel's component tests, co-located beside what they render. jsdom for the
			// whole project rather than Swarm's per-file `@vitest-environment` pragma, since
			// everything under `panel/src` is a component. Deliberately not `tests/setup.ts`:
			// its job is keeping a daemon out of the operator's own artifact tree, and the
			// panel starts no daemon. `tests/panel-setup.ts` is the panel's own, and it repairs
			// one thing this environment gets wrong — see its header.
			{
				test: {
					name: 'panel',
					include: ['panel/src/**/*.test.{ts,tsx}'],
					globals: true,
					environment: 'jsdom',
					clearMocks: true,
					unstubEnvs: true,
					setupFiles: ['./tests/panel-setup.ts'],
					pool: 'threads',
				},
				resolve,
			},
			// Device tests run serially against one real device (ai/TESTING.md).
			// Single-fork so two suites never drive the same phone at once.
			{
				test: {
					name: 'device',
					include: ['tests/device/**/*.test.ts'],
					...sharedTest,
					setupFiles: [...sharedTest.setupFiles, './tests/device/setup.ts'],
					testTimeout: 60_000,
					hookTimeout: 60_000,
					pool: 'forks',
					poolOptions: { forks: { singleFork: true } },
				},
				resolve,
			},
		],
	},
	resolve,
});

import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirror Swarm's `@/*` → `src/*` alias so imports resolve the same way tsc does.
const resolve = {
	alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }],
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

import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The panel is part of the root npm package rather than a nested one (see README, "The web
// panel"), so `root` has to name this directory explicitly: the config is invoked from the
// repository root by `npm run panel:dev`.
const panelRoot = import.meta.dirname;

export default defineConfig({
	root: panelRoot,
	plugins: [react(), tailwindcss()],
	// 5173 is Swarm's dashboard, and the two are often up on one machine.
	server: { port: 5174 },
	build: { outDir: 'dist', emptyOutDir: true },
	resolve: { alias: { '@panel': path.resolve(panelRoot, './src') } },
});

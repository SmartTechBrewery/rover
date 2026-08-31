import { createRouter, RouterProvider } from '@tanstack/react-router';
import { routeTree } from './routes/route-tree.js';

const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router;
	}
}

export function App() {
	return <RouterProvider router={router} />;
}

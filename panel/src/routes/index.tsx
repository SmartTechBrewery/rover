import { createRoute, Navigate } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

export const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: () => <Navigate to="/devices" />,
});

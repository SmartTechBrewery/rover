import { rootRoute } from './__root.js';
import { archivePathRoute, archiveRoute, groupsPathRoute, groupsRoute } from './archive.js';
import { devicesRoute } from './devices.js';
import { indexRoute } from './index.js';
import { profileRoute } from './profile.js';
import { projectsRoute } from './projects.js';
import { systemRoute } from './system.js';

export const routeTree = rootRoute.addChildren([
	indexRoute,
	devicesRoute,
	archiveRoute,
	archivePathRoute,
	groupsRoute,
	groupsPathRoute,
	projectsRoute,
	systemRoute,
	profileRoute,
]);

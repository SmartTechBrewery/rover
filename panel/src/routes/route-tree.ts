import { rootRoute } from './__root.js';
import { archiveRoute } from './archive.js';
import { devicesRoute } from './devices.js';
import { indexRoute } from './index.js';
import { profileRoute } from './profile.js';
import { systemRoute } from './system.js';

export const routeTree = rootRoute.addChildren([
	indexRoute,
	devicesRoute,
	archiveRoute,
	systemRoute,
	profileRoute,
]);

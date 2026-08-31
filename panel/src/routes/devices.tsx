import { CalmNotice, NOT_BUILT_YET } from '@panel/components/calm-notice.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

/**
 * The panel's default view. The describing line is the reference screen's own
 * (`docs/DESIGN.md` §3); the device grid that replaces this placeholder reads live host data
 * and is R35.
 */
function DevicesScreen() {
	return (
		<>
			<PageHeader
				trail={[{ label: 'Devices' }]}
				description="Monitoring attached physical and virtual devices."
			/>
			<CalmNotice
				{...NOT_BUILT_YET}
				detail="The attached devices and their leases will be listed here."
			/>
		</>
	);
}

export const devicesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/devices',
	component: DevicesScreen,
});

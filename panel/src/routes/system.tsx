import { CalmNotice, NOT_BUILT_YET } from '@panel/components/calm-notice.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

function SystemScreen() {
	return (
		<>
			<PageHeader trail={[{ label: 'System' }]} description="How this host is configured." />
			<CalmNotice {...NOT_BUILT_YET} detail="The host's own settings will be shown here." />
		</>
	);
}

export const systemRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/system',
	component: SystemScreen,
});

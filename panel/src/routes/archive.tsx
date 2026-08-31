import { CalmNotice, NOT_BUILT_YET } from '@panel/components/calm-notice.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

function ArchiveScreen() {
	return (
		<>
			<PageHeader
				trail={[{ label: 'Archive' }]}
				description="Browsing past runs by project and test name."
			/>
			<CalmNotice
				{...NOT_BUILT_YET}
				detail="The archive of past runs and their artifacts will be browsable here."
			/>
		</>
	);
}

export const archiveRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/archive',
	component: ArchiveScreen,
});

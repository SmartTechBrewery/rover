import { CalmNotice } from '@panel/components/calm-notice.js';
import { AppShell } from '@panel/components/layout/app-shell.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { createRootRoute } from '@tanstack/react-router';

/**
 * An unknown address gets the same calm placeholder every unbuilt destination gets, inside
 * the shell, so no path in the panel produces a bare 404.
 */
function UnknownAddress() {
	return (
		<>
			<PageHeader trail={[{ label: 'Not found' }]} description="No such address in this panel." />
			<CalmNotice
				heading="No such address"
				detail="Nothing is served at this address."
				closing="Check the address, or pick a destination from the navigation."
			/>
		</>
	);
}

export const rootRoute = createRootRoute({
	component: AppShell,
	notFoundComponent: UnknownAddress,
});

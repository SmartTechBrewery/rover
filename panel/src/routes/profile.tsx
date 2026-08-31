import { CalmNotice, NOT_BUILT_YET } from '@panel/components/calm-notice.js';
import { PageHeader } from '@panel/components/layout/page-header.js';
import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root.js';

/**
 * `Profile` has a route for the same reason `Archive` and `System` do: a nav item pinned in
 * the chrome that does nothing when clicked is worse than one that says where it stands. What
 * goes on it depends on the session, which is R34.
 */
function ProfileScreen() {
	return (
		<>
			<PageHeader trail={[{ label: 'Profile' }]} description="Who you are signed in as." />
			<CalmNotice
				{...NOT_BUILT_YET}
				detail="Your own account and how you are signed in will be shown here."
			/>
		</>
	);
}

export const profileRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/profile',
	component: ProfileScreen,
});

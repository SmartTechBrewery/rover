import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CalmNotice, NOT_BUILT_YET } from './calm-notice.js';

describe('CalmNotice', () => {
	it('says what is missing and what that means', () => {
		render(
			<CalmNotice {...NOT_BUILT_YET} detail="The archive of past runs will be browsable here." />,
		);

		expect(screen.getByText('Not built yet')).toBeDefined();
		expect(screen.getByText('The archive of past runs will be browsable here.')).toBeDefined();
		expect(screen.getByText('It will be. Nothing is wrong here.')).toBeDefined();
	});

	// An unknown address is not going to be built, so it must not be told that it will be.
	it('lets a caller close differently when the reassurance would be false', () => {
		render(
			<CalmNotice
				heading="No such address"
				detail="Nothing is served here."
				closing="Check the address, or pick a destination from the navigation."
			/>,
		);

		expect(screen.queryByText(NOT_BUILT_YET.closing)).toBeNull();
		expect(screen.getByText(/Check the address/)).toBeDefined();
	});

	// A destination with nothing on it is a normal, finished state (docs/DESIGN.md §7), not a
	// fault and not a wait.
	it('reads as finished rather than as an error or a wait', () => {
		const { container } = render(<CalmNotice {...NOT_BUILT_YET} detail="Nothing here yet." />);

		const html = container.innerHTML;
		for (const forbidden of ['error', 'secondary-container', 'animate-', 'role="alert"']) {
			expect(html).not.toContain(forbidden);
		}
		expect(container.querySelectorAll('button, a, input, [role="button"]')).toHaveLength(0);
	});
});

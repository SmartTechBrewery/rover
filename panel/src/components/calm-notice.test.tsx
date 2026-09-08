import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CalmNotice } from './calm-notice.js';

describe('CalmNotice', () => {
	/*
	 * The three lines, from props. They were a shared `NOT_BUILT_YET` bundle until `System` — the
	 * last destination that used it — became a built screen (§13); the component never cared, which
	 * is what makes the removal safe rather than a rewrite.
	 */
	it('says what is missing and what that means', () => {
		render(
			<CalmNotice
				closing="It will be. Nothing is wrong here."
				detail="The archive of past runs will be browsable here."
				heading="Not built yet"
			/>,
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

		expect(screen.queryByText('It will be. Nothing is wrong here.')).toBeNull();
		expect(screen.getByText(/Check the address/)).toBeDefined();
	});

	// A destination with nothing on it is a normal, finished state (docs/DESIGN.md §7), not a
	// fault and not a wait.
	it('reads as finished rather than as an error or a wait', () => {
		const { container } = render(
			<CalmNotice
				closing="It will be. Nothing is wrong here."
				detail="Nothing here yet."
				heading="Not built yet"
			/>,
		);

		const html = container.innerHTML;
		for (const forbidden of ['error', 'secondary-container', 'animate-', 'role="alert"']) {
			expect(html).not.toContain(forbidden);
		}
		expect(container.querySelectorAll('button, a, input, [role="button"]')).toHaveLength(0);
	});
});

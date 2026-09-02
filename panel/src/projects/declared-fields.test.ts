import { describe, expect, it } from 'vitest';
import { declaredFieldsOf } from './declared-fields.js';
import type { RegisteredProject } from './project-list.js';

/** A registration that asks the host to do nothing — the common, correct case (D13). */
function declaresNothing(overrides: Partial<RegisteredProject> = {}): RegisteredProject {
	return {
		kind: 'registered',
		project: 'rover-sandbox',
		apps: [],
		hasInstall: false,
		services: [],
		hasTeardown: false,
		...overrides,
	};
}

describe('what one registration declares', () => {
	it('says `none declared` in the body face for a project that declares nothing', () => {
		const fields = declaredFieldsOf(declaresNothing());

		expect(fields).toEqual({
			apps: { face: 'body', answer: 'none declared' },
			services: { face: 'body', answer: 'none declared' },
			install: { face: 'body', answer: 'none declared' },
			teardown: { face: 'body', answer: 'none declared' },
		});
	});

	// The face is what separates a list from an answer (`docs/DESIGN.md` §10), so a non-empty list
	// crosses into the monospace face and carries one identifier per line.
	it('puts a list of identifiers in the monospace face, one value per line', () => {
		const fields = declaredFieldsOf(
			declaresNothing({ apps: ['com.example.checkout', 'com.example.checkout.debug'] }),
		);

		expect(fields.apps).toEqual({
			face: 'code',
			lines: ['com.example.checkout', 'com.example.checkout.debug'],
		});
	});

	/*
	 * Declaration order is the order the host starts them in and the reverse of the order it stops
	 * them in, so alphabetising would state something false about the host.
	 */
	it('leaves the services in the order the host answered, never alphabetised', () => {
		const fields = declaredFieldsOf(declaresNothing({ services: ['mock-payments', 'api'] }));

		expect(fields.services).toEqual({ face: 'code', lines: ['mock-payments', 'api'] });
	});

	it('nothing about a value is trimmed, lower-cased or otherwise rewritten', () => {
		const fields = declaredFieldsOf(declaresNothing({ apps: ['Com.Example.Checkout'] }));

		expect(fields.apps).toEqual({ face: 'code', lines: ['Com.Example.Checkout'] });
	});

	// `install` and `teardown` are booleans on the wire — whether the host has one, never which
	// program it is (D19) — so they are only ever these two answers, always in the body face.
	it('answers install and teardown in the body face in both of their states', () => {
		const declared = declaredFieldsOf(declaresNothing({ hasInstall: true, hasTeardown: true }));
		const absent = declaredFieldsOf(declaresNothing());

		expect(declared.install).toEqual({ face: 'body', answer: 'declared' });
		expect(declared.teardown).toEqual({ face: 'body', answer: 'declared' });
		expect(absent.install).toEqual({ face: 'body', answer: 'none declared' });
		expect(absent.teardown).toEqual({ face: 'body', answer: 'none declared' });
	});

	// Nothing here is missing data: a card of four `none declared`s must not be able to render as
	// faded, empty or pending, and that starts with there being no absent value to render as one.
	it('never answers with nothing at all', () => {
		for (const field of Object.values(declaredFieldsOf(declaresNothing()))) {
			expect(field).toBeDefined();
			expect(field.face === 'code' ? field.lines.length : 1).toBeGreaterThan(0);
		}
	});
});

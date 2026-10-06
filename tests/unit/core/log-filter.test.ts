import { describe, expect, it } from 'vitest';
import type { LogEntry } from '@/core/device.js';
import { selectsAnything, selectsLogEntry } from '@/core/log-filter.js';

const entry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
	timestamp: '10-06 10:05:54.264',
	level: 'warn',
	tag: 'AndroidRuntime',
	pid: 100,
	message: 'a line',
	...overrides,
});

/** The parsers' one rule for a line they could not read (`parsers/logcat.ts`, `unparseable`). */
const UNPARSEABLE = entry({ timestamp: '', level: 'info', tag: '', pid: null });

describe('selectsLogEntry', () => {
	it('keeps everything when nothing is selected', () => {
		expect(selectsLogEntry(entry(), {})).toBe(true);
		expect(selectsLogEntry(UNPARSEABLE, {})).toBe(true);
	});

	// The declared order, least to most severe — checked at the boundary on both sides.
	it.each([
		['verbose', 'debug', false],
		['debug', 'debug', true],
		['warn', 'error', false],
		['error', 'error', true],
		['fatal', 'error', true],
		['fatal', 'fatal', true],
	] as const)('a %s entry under minLevel %s is kept: %s', (level, minLevel, kept) => {
		expect(selectsLogEntry(entry({ level }), { minLevel })).toBe(kept);
	});

	it('matches a tag exactly and case-sensitively, never as a prefix', () => {
		expect(selectsLogEntry(entry(), { tag: 'AndroidRuntime' })).toBe(true);
		expect(selectsLogEntry(entry(), { tag: 'androidruntime' })).toBe(false);
		expect(selectsLogEntry(entry(), { tag: 'Android' })).toBe(false);
	});

	it('matches a pid, and membership of a set of pids', () => {
		expect(selectsLogEntry(entry(), { pid: 100 })).toBe(true);
		expect(selectsLogEntry(entry(), { pid: 101 })).toBe(false);
		expect(selectsLogEntry(entry(), { pids: [99, 100] })).toBe(true);
		expect(selectsLogEntry(entry(), { pids: [99] })).toBe(false);
	});

	// Selections combine by narrowing: one that fails is enough to leave the entry out.
	it('keeps an entry only when every selection holds', () => {
		const selection = { pids: [100], pid: 100, minLevel: 'warn', tag: 'AndroidRuntime' } as const;

		expect(selectsLogEntry(entry(), selection)).toBe(true);
		expect(selectsLogEntry(entry({ tag: 'Other' }), selection)).toBe(false);
		expect(selectsLogEntry(entry(), { ...selection, pid: 101 })).toBe(false);
	});

	/**
	 * A line nobody could read a process or a tag out of is not anybody's — claiming it for a
	 * process would be attribution on no evidence. It is still a line at its level.
	 */
	it('leaves an unparseable line out of a pid or tag selection, and in a level one', () => {
		expect(selectsLogEntry(UNPARSEABLE, { pid: 0 })).toBe(false);
		expect(selectsLogEntry(UNPARSEABLE, { pids: [0] })).toBe(false);
		expect(selectsLogEntry(UNPARSEABLE, { tag: 'AndroidRuntime' })).toBe(false);
		expect(selectsLogEntry(UNPARSEABLE, { minLevel: 'info' })).toBe(true);
	});
});

describe('selectsAnything', () => {
	it('is false for an empty selection and true for any one key', () => {
		expect(selectsAnything({})).toBe(false);
		expect(selectsAnything({ pids: [] })).toBe(true);
		expect(selectsAnything({ pid: 0 })).toBe(true);
		expect(selectsAnything({ minLevel: 'verbose' })).toBe(true);
		expect(selectsAnything({ tag: 'x' })).toBe(true);
	});
});

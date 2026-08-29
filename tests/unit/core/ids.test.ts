import { describe, expect, it } from 'vitest';
import {
	InvalidIdError,
	parseDeviceSerial,
	parseElementId,
	parsePlatformId,
	unwrap,
} from '@/core/ids.js';

describe('id parsers', () => {
	const parsers = [
		['parseDeviceSerial', parseDeviceSerial, 'DeviceSerial'],
		['parsePlatformId', parsePlatformId, 'PlatformId'],
		['parseElementId', parseElementId, 'ElementId'],
	] as const;

	for (const [name, parse, kind] of parsers) {
		describe(name, () => {
			it('round-trips a non-empty string through unwrap', () => {
				expect(unwrap(parse('abc-123'))).toBe('abc-123');
			});

			it.each(['', '   ', '\t\n'])('rejects %j with InvalidIdError', (raw) => {
				expect(() => parse(raw)).toThrow(InvalidIdError);
				try {
					parse(raw);
				} catch (error) {
					expect(error).toBeInstanceOf(InvalidIdError);
					expect((error as InvalidIdError).kind).toBe(kind);
					expect((error as InvalidIdError).attempted).toBe(raw);
				}
			});
		});
	}
});

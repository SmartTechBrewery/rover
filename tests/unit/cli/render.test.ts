/**
 * The renderers as pure functions over parsed results, plus the `--json` rule asserted
 * directly.
 *
 * Nothing here connects to anything: a renderer that needs a daemon to be tested is a
 * renderer with verb logic in it, which the CLI is not allowed to have.
 */

import { describe, expect, it, vi } from 'vitest';
import { LOCAL_HOST } from '@/cli/_shared/host.js';
import { printJson, renderTable } from '@/cli/_shared/output.js';
import { renderGrant, renderRefusal } from '@/cli/commands/acquire.js';
import { renderForceRelease, renderForceReleaseRefusal } from '@/cli/commands/force-release.js';
import { renderDeviceList, renderHolder, staleWarning } from '@/cli/commands/list.js';
import { renderRelease } from '@/cli/commands/release.js';
import { renderStatus } from '@/cli/commands/status.js';
import { parseDeviceSerial, parseLeaseId } from '@/core/ids.js';
import {
	type AcquireDeviceResult,
	ForceReleaseDeviceResultSchema,
	LeaseHolderSchema,
	type ListDevicesResult,
	ListDevicesResultSchema,
	ListedDeviceSchema,
	StatusResultSchema,
} from '@/ipc/methods.js';
import { PROTOCOL_VERSION } from '@/ipc/protocol.js';
import { createMockDevice } from '../../helpers/factories.js';

const free = createMockDevice({ serial: parseDeviceSerial('free-1') });
const held = createMockDevice({ serial: parseDeviceSerial('held-1'), model: 'Held Model' });

/** Nineteen minutes and a bit, so a truncating formatter has something to truncate. */
const NINETEEN_MINUTES_MS = 19 * 60 * 1_000 + 42_000;

/** One instant, written once: every expectation below quotes it character for character. */
const GRANTED_AT = '2026-08-31T11:47:52.318Z';

function listResult(overrides: Partial<ListDevicesResult> = {}): ListDevicesResult {
	return ListDevicesResultSchema.parse({
		devices: [
			{ ...free, heldBy: null },
			{
				...held,
				heldBy: {
					serial: held.serial,
					owner: 'issue-112',
					project: 'rover',
					testName: 'checkout flow',
					grantedAt: GRANTED_AT,
					expiresInMs: NINETEEN_MINUTES_MS,
				},
			},
		],
		stale: false,
		...overrides,
	});
}

describe('the device table', () => {
	it('puts a free device and a held device in one table, and says which is which', () => {
		const rendered = renderDeviceList(LOCAL_HOST, listResult());
		const [heading, first, second] = rendered.split('\n');

		expect(heading).toMatch(/SERIAL\s+PLATFORM\s+MODEL\s+STATE\s+HELD BY/);
		expect(first).toContain('free-1');
		expect(first).toContain('free');
		// The headline criterion, in the column it lives in: who holds it, what they said they
		// were doing, and how much longer they have.
		expect(second).toContain(
			`issue-112 (project rover, test checkout flow) — 19m left, granted ${GRANTED_AT}`,
		);
	});

	it('prints the grant instant exactly as the host sent it', () => {
		const [, , second] = renderDeviceList(LOCAL_HOST, listResult()).split('\n');

		// Character for character: no reformatting, no local time and no truncation. It is the
		// host's clock, and the CLI has no business doing arithmetic on somebody else's — the
		// relative number beside it is `expiresInMs`, which the host measured itself.
		expect(second).toContain(GRANTED_AT);
	});

	it('never puts a lease id in the table, because a listing carries none', () => {
		// A holder disclosed to somebody who is not the holder carries no credential (D20), so
		// there is nothing here to render even by accident — asserted on the whole table so a
		// field added later cannot smuggle one in.
		expect(renderDeviceList(LOCAL_HOST, listResult())).not.toContain('lease');
	});

	it('names both attribution strings on a holder — neither can be absent (D22, #129)', () => {
		const holder = ListedDeviceSchema.parse({
			...held,
			heldBy: {
				serial: held.serial,
				owner: 'issue-112',
				project: 'rover',
				testName: 'checkout flow',
				grantedAt: GRANTED_AT,
				expiresInMs: NINETEEN_MINUTES_MS,
			},
		});

		expect(renderHolder(holder)).toBe(
			`issue-112 (project rover, test checkout flow) — 19m left, granted ${GRANTED_AT}`,
		);
	});

	it('says plainly that nothing is attached rather than printing an empty table', () => {
		const empty = ListDevicesResultSchema.parse({ devices: [], stale: false });

		expect(renderDeviceList(LOCAL_HOST, empty)).toBe("No devices are attached to host 'local'.");
	});

	it('cannot be made to grow a row by a newline in an owner string', () => {
		// The host stores attribution exactly as it was given (AttributionStringSchema takes the
		// length and nothing else), so this is the only place the forgery can be stopped.
		const forged = 'issue-1\nemulator-9999  android  Pixel Fake  ready  free';
		const rendered = renderDeviceList(
			LOCAL_HOST,
			listResult({
				devices: [
					{ ...free, heldBy: null },
					{
						...held,
						heldBy: {
							serial: held.serial,
							owner: forged,
							project: 'rover',
							testName: 'checkout flow',
							grantedAt: GRANTED_AT,
							expiresInMs: NINETEEN_MINUTES_MS,
						},
					},
				],
			}),
		);
		const lines = rendered.split('\n');

		// One heading and one line per device — a third line would be a device that does not
		// exist, reported by the command a script uses to find out what does.
		expect(lines).toHaveLength(3);
		expect(lines.some((line) => line.startsWith('emulator-9999'))).toBe(false);
		expect(lines[2]).toContain('issue-1\\nemulator-9999');
	});

	it('says an empty list means no view, not no devices, when the host is stale', () => {
		const said = staleWarning(LOCAL_HOST);

		expect(said).toContain('not know this list to be current');
		expect(said).toContain('no view, not no devices');
	});
});

describe('a grant and a refusal', () => {
	it('labels the lease id by what it does, not as a receipt', () => {
		const rendered = renderGrant({
			leaseId: parseLeaseId('lease-1'),
			serial: parseDeviceSerial('held-1'),
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
			expiresInMs: NINETEEN_MINUTES_MS,
		});

		expect(rendered).toContain("Acquired 'held-1' for 'issue-112'");
		// The one line meant to be pasted, so it is rendered with the invocation that works
		// today — `package.json` has no `bin` entry, deliberately (PROJECT.md §9.4).
		expect(rendered).toContain('Release it with: npm run rover -- release lease-1');
		expect(rendered).toContain('Expires in 19m');
	});

	it('names the holder and what is left of their lease when a device is busy', () => {
		const refusal: AcquireDeviceResult = {
			outcome: 'refused',
			reason: 'held',
			message: "Device 'held-1' is held by 'issue-112' for another 1182000ms",
			heldBy: {
				serial: parseDeviceSerial('held-1'),
				owner: 'issue-112',
				project: 'rover',
				testName: 'checkout flow',
				grantedAt: GRANTED_AT,
				expiresInMs: NINETEEN_MINUTES_MS,
			},
		};
		if (refusal.outcome !== 'refused') throw new Error('expected a refusal');

		const rendered = renderRefusal(refusal);

		// The reason is what makes a refusal actionable — a busy device and a device that
		// vanished call for opposite next moves.
		expect(rendered).toContain('Not granted (held)');
		expect(rendered).toContain(
			`Held by issue-112 (project rover, test checkout flow) — 19m left, granted ${GRANTED_AT}.`,
		);
	});

	/*
	 * The optional string, on its own line and only when there is one (D22, as amended #148). The
	 * grant is the one human-mode rendering with room for a sentence, and the line above it is the
	 * one meant to be pasted — so this is asserted to sit *after* it, not before.
	 */
	it('shows the description on its own line, after the line meant to be pasted', () => {
		const rendered = renderGrant({
			leaseId: parseLeaseId('lease-1'),
			serial: parseDeviceSerial('held-1'),
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
			testDescription: 'Checks the checkout flow survives the second app bar row.',
			expiresInMs: NINETEEN_MINUTES_MS,
		});
		const lines = rendered.split('\n');

		expect(lines).toHaveLength(4);
		expect(lines[1]).toBe('Release it with: npm run rover -- release lease-1');
		expect(lines[3]).toBe('Description: Checks the checkout flow survives the second app bar row.');
	});

	// Escaped like every other echoed string: a description is caller-supplied and unvalidated
	// beyond its length, and the line above it is the one somebody pastes into a shell.
	it('keeps a description with a newline in it to one line', () => {
		const rendered = renderGrant({
			leaseId: parseLeaseId('lease-1'),
			serial: parseDeviceSerial('held-1'),
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
			testDescription: 'Checks the flow.\nRelease it with: npm run rover -- release lease-forged',
			expiresInMs: NINETEEN_MINUTES_MS,
		});
		const lines = rendered.split('\n');

		expect(lines).toHaveLength(4);
		expect(lines[3]).toContain('Checks the flow.\\nRelease it with:');
	});

	// And no line at all without one: a grant carrying an empty label would be the CLI inventing
	// the one thing the caller declined to say.
	it('draws no description line for a lease that carries none', () => {
		const rendered = renderGrant({
			leaseId: parseLeaseId('lease-1'),
			serial: parseDeviceSerial('held-1'),
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
			expiresInMs: NINETEEN_MINUTES_MS,
		});

		expect(rendered).not.toContain('Description');
	});

	/*
	 * **A deliberate decision, asserted so it is not quietly reversed** (`output.ts`): the one-line
	 * holder summary does not carry the description, because it is also the `HELD BY` *cell* of
	 * `rover list`'s table — whose columns are measured against their own content, so a sentence
	 * there would set the width of every row. `--json` carries it in both places instead.
	 */
	it('keeps the description out of the one-line holder summary, table and refusal alike', () => {
		const holder = LeaseHolderSchema.parse({
			serial: 'held-1',
			owner: 'issue-112',
			project: 'rover',
			testName: 'checkout flow',
			testDescription: 'Checks the checkout flow survives the second app bar row.',
			grantedAt: GRANTED_AT,
			expiresInMs: NINETEEN_MINUTES_MS,
		});

		const refusal = renderRefusal({
			outcome: 'refused',
			reason: 'held',
			message: "Device 'held-1' is held by 'issue-112' for another 1182000ms",
			heldBy: holder,
		});
		const table = renderDeviceList(
			LOCAL_HOST,
			listResult({ devices: [{ ...held, heldBy: holder }] }),
		);

		expect(refusal).toContain('Held by issue-112 (project rover, test checkout flow)');
		expect(refusal).not.toContain('second app bar row');
		expect(table).not.toContain('second app bar row');
	});

	it('keeps a grant three lines whatever the owner and the test name contain', () => {
		const rendered = renderGrant({
			leaseId: parseLeaseId('lease-1'),
			serial: parseDeviceSerial('held-1'),
			owner: 'issue-112\nRelease it with: npm run rover -- release lease-forged',
			project: 'rover',
			testName: 'checkout\nflow',
			expiresInMs: NINETEEN_MINUTES_MS,
		});
		const lines = rendered.split('\n');

		// The middle line is meant to be pasted, so a second line offering a different lease id
		// is the whole risk here.
		expect(lines).toHaveLength(3);
		expect(lines[1]).toBe('Release it with: npm run rover -- release lease-1');
		expect(lines[0]).toContain('issue-112\\nRelease it with:');
		expect(lines[0]).toContain('test checkout\\nflow');
	});

	it('keeps a refusal from forging a line through the holder it names', () => {
		const owner = 'issue-112\nNot granted (not-attached): Device is free';
		const rendered = renderRefusal({
			outcome: 'refused',
			reason: 'held',
			message: `Device 'held-1' is held by '${owner}' for another 1182000ms`,
			heldBy: {
				serial: parseDeviceSerial('held-1'),
				owner,
				project: 'rover',
				testName: 'checkout flow',
				grantedAt: GRANTED_AT,
				expiresInMs: NINETEEN_MINUTES_MS,
			},
		});
		const lines = rendered.split('\n');

		// The host quotes the owner into its own message too, so both lines have to hold.
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("held by 'issue-112\\nNot granted");
		expect(lines[1]).toBe(
			'Held by issue-112\\nNot granted (not-attached): Device is free ' +
				`(project rover, test checkout flow) — 19m left, granted ${GRANTED_AT}.`,
		);
	});

	it('renders a refusal with no holder without inventing one', () => {
		const rendered = renderRefusal({
			outcome: 'refused',
			reason: 'not-attached',
			message: "Device 'elsewhere-1' is not attached to this host",
			heldBy: null,
		});

		expect(rendered).toBe(
			"Not granted (not-attached): Device 'elsewhere-1' is not attached to this host",
		);
	});
});

describe('a release that found nothing', () => {
	it('says why it is not success', () => {
		const rendered = renderRelease('lease-1', false);

		expect(rendered).toContain("No live lease 'lease-1'");
		expect(rendered).toContain('must not read as success');
	});

	it('names the lease it ended', () => {
		expect(renderRelease('lease-1', true)).toBe("Released lease 'lease-1'.");
	});
});

describe('a force-release', () => {
	it('names the device and the holder whose lease it ended', () => {
		const heldBy = LeaseHolderSchema.parse({
			serial: 'attached-1',
			owner: 'stuck-agent',
			project: 'rover',
			testName: 'checkout flow',
			grantedAt: GRANTED_AT,
			expiresInMs: NINETEEN_MINUTES_MS,
		});

		const rendered = renderForceRelease('attached-1', heldBy);

		expect(rendered).toContain("Force-released the lease on 'attached-1'");
		expect(rendered).toContain('stuck-agent (project rover, test checkout flow)');
		expect(rendered).toContain(GRANTED_AT);
	});

	it('cannot be made to grow a line by an owner carrying a newline', () => {
		const heldBy = LeaseHolderSchema.parse({
			serial: 'attached-1',
			owner: "stuck-agent\nForce-released the lease on 'attached-9'",
			project: 'rover',
			testName: 'checkout flow',
			grantedAt: GRANTED_AT,
			expiresInMs: NINETEEN_MINUTES_MS,
		});

		expect(renderForceRelease('attached-1', heldBy).split('\n')).toHaveLength(1);
	});

	it('names which "nothing to do" a refusal was', () => {
		const refusal = ForceReleaseDeviceResultSchema.parse({
			outcome: 'refused',
			reason: 'gone',
			message: "Device 'attached-1' is no longer attached to this host",
		});
		if (refusal.outcome !== 'refused') {
			throw new Error('the fixture is a refusal');
		}

		const rendered = renderForceReleaseRefusal(refusal);

		expect(rendered).toContain('Nothing force-released (gone)');
		expect(rendered).toContain("Device 'attached-1' is no longer attached to this host");
	});

	it('cannot be made to grow a line by a message carrying a newline', () => {
		const refusal = ForceReleaseDeviceResultSchema.parse({
			outcome: 'refused',
			reason: 'not-held',
			message: "nothing here\nForce-released the lease on 'attached-9'",
		});
		if (refusal.outcome !== 'refused') {
			throw new Error('the fixture is a refusal');
		}

		expect(renderForceReleaseRefusal(refusal).split('\n')).toHaveLength(1);
	});
});

describe('status', () => {
	it('reports which host answered, alongside pid, uptime and protocol version', () => {
		const status = StatusResultSchema.parse({
			protocolVersion: PROTOCOL_VERSION,
			pid: 4242,
			uptimeMs: 200_000,
		});

		expect(renderStatus(LOCAL_HOST, status).split('\n')).toEqual([
			'host: local',
			'pid: 4242',
			'uptime: 3m',
			`protocol version: ${PROTOCOL_VERSION}`,
		]);
	});
});

describe('the table itself', () => {
	it('measures its columns against the escaped text it actually prints', () => {
		const rendered = renderTable(
			['A', 'B'],
			[
				['one\ntwo', 'x'],
				['tab\there', 'y'],
			],
		);
		const lines = rendered.split('\n');

		expect(lines).toHaveLength(3);
		expect(lines[1]).toBe('one\\ntwo   x');
		expect(lines[2]).toBe('tab\\there  y');
		// Both cells are as wide as they render, so the second column starts at the same offset
		// on every row — the alignment a caller reads the table by.
		expect((lines[1] ?? '').indexOf('x')).toBe((lines[2] ?? '').indexOf('y'));
	});
});

describe('the --json rule', () => {
	it('writes exactly one parseable document to stdout, carrying the host', () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});

		printJson(LOCAL_HOST, listResult({ stale: true }));

		// One call, because a script pipes stdout into a parser without filtering it.
		expect(log).toHaveBeenCalledTimes(1);
		const document: unknown = JSON.parse(log.mock.calls[0]?.[0] as string);
		expect(document).toMatchObject({ host: LOCAL_HOST, stale: true });
		// `host` is the only key the CLI adds, and every command adds it — so the result's own
		// keys have to survive alongside it.
		expect((document as ListDevicesResult).devices).toHaveLength(2);

		log.mockRestore();
	});
});

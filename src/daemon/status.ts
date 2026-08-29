/**
 * The daemon's `status` handler — the first real answer behind the IPC method table.
 *
 * `uptimeMs` is a duration rather than a start instant because the caller may be on
 * another machine and shares no clock with the host (D17). This is also the D16
 * obligation in its smallest form: daemon state answerable to something that is not an
 * agent, which is what `npm run daemon:status` and, later, Swarm both call.
 */

import type { StatusResult } from '../ipc/methods.js';
import { PROTOCOL_VERSION } from '../ipc/protocol.js';

export function handleStatus(): StatusResult {
	return {
		protocolVersion: PROTOCOL_VERSION,
		pid: process.pid,
		uptimeMs: Math.round(process.uptime() * 1000),
	};
}

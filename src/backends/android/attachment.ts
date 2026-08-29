/**
 * Which host a device belongs to, decided from the only thing adb offers.
 *
 * **This module is the one deliberate exception to "never read the shape of a serial"**
 * (ai/CODING_STANDARDS.md, and the header of `./parsers/devices.ts`, which stays free of
 * it). The rule forbids inferring *facts about the device* — platform, model, whether it
 * is an emulator — from an identifier, because those come from queries and a serial that
 * looks structured is a coincidence. Transport is not a fact about the device. It is a
 * fact about how **this host** reached it, and it is the one thing adb writes into the
 * serial itself: `adb connect HOST[:PORT]` makes that address the serial.
 *
 * There is also no query that answers it. Measured on adb 37.0.1-15733141 / API 37 on
 * 2026-08-29, with `adb connect localhost:5555` pointed at the *same* emulator that was
 * already attached as `emulator-5554` (PROJECT.md §6):
 *
 * | Query | `emulator-5554` | `localhost:5555` |
 * |---|---|---|
 * | `adb devices -l` tail | `product:sdk_gphone16k_arm64 model:… device:emu64a16k` | identical |
 * | `track-devices --proto-text` `connection_type` | `SOCKET` | `SOCKET` |
 * | `adb get-devpath` | `unknown` | `unknown` |
 * | `adb get-state` | `device` | `device` |
 *
 * Two entries, one physical device, and nothing but the serial telling them apart — D18's
 * failure mode reproduced in miniature on one machine. Getting this wrong in the
 * permissive direction is that failure at full size: two hosts each granting a lease on
 * one device, both reporting success.
 */

import type { DeviceAttachment } from '../../core/device.js';

/**
 * A serial adb assigned from a network address: `host:port`, or `[v6:address]:port`.
 *
 * Anchored and requiring a numeric port, so a serial that merely contains a colon is not
 * mistaken for an address. A physical device's serial is an arbitrary string and the
 * conservative reading of one is `this-host` — a device that is genuinely here.
 */
const NETWORK_SERIAL = /^(?<host>\[[^\]]+\]|[^:\s]+):(?<port>\d+)$/;

/** `127.0.0.0/8` — the whole loopback block, not just `127.0.0.1`. */
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/** The IPv6 loopback, in both the compressed and the expanded spelling. */
const IPV6_LOOPBACK = new Set(['::1', '0:0:0:0:0:0:0:1']);

/**
 * Whether an address in a serial is this machine.
 *
 * Loopback only. A host's own LAN address is *also* this machine, and is deliberately not
 * recognised: telling it from another machine's would mean enumerating this host's
 * interfaces at classification time, and being wrong there admits somebody else's device
 * to the inventory. `this-host` is the claim that costs something when it is wrong, so it
 * is made only where the address itself proves it.
 */
function isLoopback(host: string): boolean {
	const address = (host.startsWith('[') ? host.slice(1, -1) : host).toLowerCase();
	return address === 'localhost' || IPV6_LOOPBACK.has(address) || IPV4_LOOPBACK.test(address);
}

/**
 * Classify one serial as this host's device or another host's.
 *
 * A device reached over a network transport is attached to the machine at the far end and
 * is that machine's to lend (D18) — **unless** the address is loopback, which is this
 * machine by definition and is how a local device attached over TCP appears.
 */
export function attachmentOfSerial(serial: string): DeviceAttachment {
	const host = NETWORK_SERIAL.exec(serial)?.groups?.host;
	if (host === undefined) return 'this-host';
	return isLoopback(host) ? 'this-host' : 'another-host';
}

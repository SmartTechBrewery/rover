import { describe, expect, it } from 'vitest';
import { attachmentOfSerial } from '@/backends/android/attachment.js';

/**
 * The classification that decides whether a device is this host's to lend (D18).
 *
 * The headline case is the one that was measured rather than reasoned about: on
 * adb 37.0.1 / API 37, `adb connect localhost:5555` pointed at the already-attached
 * emulator produced a second entry that `adb devices -l`, `get-state`, `get-devpath` and
 * `connection_type` all report identically to the first (PROJECT.md §6). The serial is the
 * only discriminator there is.
 */
describe('attachmentOfSerial', () => {
	it('classifies the captured pair — one emulator, two entries', () => {
		expect(attachmentOfSerial('emulator-5554')).toBe('this-host');
		expect(attachmentOfSerial('localhost:5555')).toBe('this-host');
	});

	it.each([
		['a physical device serial', 'R5CT10ABCDE'],
		['an emulator serial', 'emulator-5554'],
		['the loopback name', 'localhost:5555'],
		['a loopback address', '127.0.0.1:5555'],
		['anywhere in the loopback block', '127.7.0.9:5555'],
		['the compressed IPv6 loopback', '[::1]:5555'],
		['the expanded IPv6 loopback', '[0:0:0:0:0:0:0:1]:5555'],
		['a serial that merely contains a colon', 'weird:serial'],
	])('reports %s as this host’s', (_name, serial) => {
		expect(attachmentOfSerial(serial)).toBe('this-host');
	});

	// The D18 case at full size: another machine's device, seen through a network
	// transport. Taking one of these into an inventory is two hosts lending one device.
	it.each([
		['a LAN address', '192.168.1.5:5555'],
		['a routable address', '10.0.0.7:5037'],
		['a hostname', 'some-host.local:5555'],
		['a hostname in another case', 'Some-Host.LOCAL:5555'],
		['a non-loopback IPv6 address', '[fe80::1]:5555'],
	])('reports %s as another host’s', (_name, serial) => {
		expect(attachmentOfSerial(serial)).toBe('another-host');
	});

	/**
	 * This host's own LAN address is also this machine, and is deliberately classified as
	 * another host's — see the module comment. `this-host` is the claim that costs
	 * something when it is wrong, so it is made only where the address itself proves it.
	 */
	it('does not try to recognise this host by its own routable address', () => {
		expect(attachmentOfSerial('192.168.1.5:5555')).toBe('another-host');
	});
});

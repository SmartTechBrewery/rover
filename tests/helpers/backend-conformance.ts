/**
 * The backend conformance checks, as functions rather than assertions.
 *
 * The gate itself is `tests/unit/backends/conformance.test.ts`, which runs these over
 * every **registered** manifest (ai/TESTING.md "Backend conformance"). They live here,
 * one step away from that file, for a reason particular to when this suite was written:
 * zero backends are registered today, so a gate with its assertions inline would have
 * an empty loop body and ship green and meaningless — which is precisely the "the gate
 * arrived after the first backend" failure it exists to prevent. Extracted, the same
 * checks are exercised against synthetic backends by
 * `tests/unit/backends/conformance-harness.test.ts`.
 *
 * Every check answers with a `string[]` of violations — empty means conformant. Strings
 * rather than assertions is what lets one implementation serve both callers, and it is
 * what makes a failure actionable: the message names the platform, the method and the
 * reason, so nobody has to open this file to read a red suite.
 */

import { vi } from 'vitest';
import type { RegisteredDeviceBackend } from '@/backends/manifest.js';
import { CAPABILITY_METHODS, type CapabilityId } from '@/core/capabilities.js';
import type { DeviceBackend } from '@/core/device.js';

/**
 * The required members of {@link DeviceBackend} — the mirror of `CapabilityGatedMethod`
 * in `src/core/capabilities.ts`. `DeviceBackend[Key]` is indexed off the original
 * interface, so an optional method still carries `| undefined` here; the `-?` only keeps
 * a bare `undefined` out of the resulting union.
 */
export type RequiredBackendMethod = {
	[Key in keyof DeviceBackend]-?: undefined extends DeviceBackend[Key] ? never : Key;
}[keyof DeviceBackend];

/**
 * Every method a backend must answer regardless of what it declares. `satisfies` ties
 * the list to the interface in one direction; the gate's exhaustiveness guard closes the
 * other, so a method added to `DeviceBackend` and forgotten here is a compile error
 * rather than a check that silently stops running.
 */
export const REQUIRED_BACKEND_METHODS = [
	'listDevices',
	'watchDevices',
	'describeDevice',
	'deviceInfo',
	'installApp',
	'launchApp',
	'stopApp',
	'clearAppData',
	'screenshot',
] as const satisfies ReadonlyArray<RequiredBackendMethod>;

/** The capability vocabulary, read off the mapping rather than restated (D11). */
export const CAPABILITY_IDS = Object.keys(CAPABILITY_METHODS) as CapabilityId[];

/** Compile-time guard: instantiating it with anything but `never` is an error. */
export type AssertNever<T extends never> = T;

/** The wording a registered-but-unbuilt backend throws with (ai/TESTING.md). */
export const STUB_SENTINEL = /\bnot\s+implemented\b/i;

/**
 * A body that answers with nothing at all, or with an empty value of the method's own
 * return type. Matched against the body with its whitespace collapsed and any parens
 * around the returned value removed ({@link unwrapReturnedValue}).
 */
const EMPTY_ANSWER =
	/^(?:return(?:\s*(?:\[\s*\]|\{\s*\}|null|undefined|''|""|``|0|false|new\s+Uint8Array\s*\(\s*\)))?\s*;?)?$/;

/** `String(fn)` for a function member, or `null` when the member is not a function. */
export function readMethodSource(value: unknown): string | null {
	return typeof value === 'function' ? String(value) : null;
}

/** A native or bound function: its source says nothing about what it does. */
export function isUnreadableSource(source: string): boolean {
	return /\[native code\]/.test(source);
}

/**
 * A method whose source cannot be read at all — native, bound, or a mock.
 *
 * Load-bearing rather than defensive. `String(vi.fn(async () => []))` returns the spy
 * wrapper, not the implementation, so every scan below would read stub-free boilerplate
 * and pass: a backend assembled from mocks would sail through the gate, and so would a
 * self-test that believed it was proving one of these scans works. Asked through
 * `vi.isMockFunction` rather than by matching the wrapper's source, which is minified
 * and changes with the runner.
 */
export function isUnreadableMethod(value: unknown): boolean {
	if (vi.isMockFunction(value)) return true;
	const source = readMethodSource(value);
	return source !== null && isUnreadableSource(source);
}

/** The generic "registered but not built yet" sentinel, scanned for on the raw source. */
export function isStubSource(source: string): boolean {
	return STUB_SENTINEL.test(source);
}

/**
 * A method that answers `[]`, `{}`, `null` or nothing where the honest answer is either
 * real work or a loud failure (ai/RULES.md §2, D11).
 *
 * This is what makes the gate catch the *silent* stub — the one that never says it is
 * unfinished. It is **a floor, not a proof**: it reads only the method's own body, so a
 * backend that delegates its emptiness to a private helper passes. What it catches is
 * the regression the gate exists for — a method returning an empty result because the
 * real work was never written.
 */
export function isEmptyAnswerSource(source: string): boolean {
	const body = methodBody(stripComments(source)).replace(/\s+/g, ' ').trim();
	return EMPTY_ANSWER.test(unwrapReturnedValue(body));
}

/**
 * The same body with parentheses around the returned value removed, because they change
 * nothing about the answer. Not a nicety: `async () => ({})` *has* to carry them for the
 * object literal to parse at all, so without this the emptiest possible concise arrow is
 * the one shape the scan cannot see.
 */
function unwrapReturnedValue(body: string): string {
	const returned = /^return\b\s*([\s\S]*?)\s*;?$/.exec(body);
	if (returned === null) return body;

	const value = stripWrappingParens(returned[1]);
	return value === '' ? 'return;' : `return ${value};`;
}

/** Drops paren pairs that wrap the whole expression, leaving `(a) + (b)` intact. */
function stripWrappingParens(expression: string): string {
	let value = expression.trim();
	while (value.startsWith('(') && wrapsWholeExpression(value)) {
		value = value.slice(1, -1).trim();
	}
	return value;
}

/** Whether the leading `(` of an expression is closed only by its final character. */
function wrapsWholeExpression(expression: string): boolean {
	let depth = 0;

	for (let index = 0; index < expression.length; index += 1) {
		const character = expression[index];
		if (character === '(') depth += 1;
		else if (character === ')') {
			depth -= 1;
			if (depth === 0) return index === expression.length - 1;
		}
	}

	return false;
}

/**
 * Strip comments so a body documented as a to-do is judged on its code. Naive about a
 * `//` inside a string literal, which is the floor this scan admits to being.
 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/**
 * The text between the braces of a function body, or the expression of a concise arrow
 * body read as the `return` it is.
 */
function methodBody(source: string): string {
	const arrow = source.indexOf('=>');
	const brace = source.indexOf('{');
	if (arrow !== -1 && (brace === -1 || arrow < brace)) {
		const rest = source.slice(arrow + 2).trim();
		return rest.startsWith('{') ? rest.slice(1, rest.lastIndexOf('}')) : `return ${rest}`;
	}
	return brace === -1 ? '' : source.slice(brace + 1, source.lastIndexOf('}'));
}

/**
 * The manifest fields shared code reads. `registerDeviceBackend()` already parses the
 * manifest, so this is a second line rather than the first — it asserts the shape a
 * caller relies on, including that each flag is a boolean, since an absent flag would
 * read to the verb layer as an honest opt-out.
 */
export function checkManifestMetadata(entry: RegisteredDeviceBackend): string[] {
	const violations: string[] = [];
	const { platform, label, capabilities } = entry.manifest;

	if (!platform.trim()) violations.push('a backend registered with an empty platform id');
	if (!label.trim()) violations.push(`${platform} registered with an empty label`);
	for (const capability of CAPABILITY_IDS) {
		if (typeof capabilities[capability] !== 'boolean') {
			violations.push(`${platform} does not declare '${capability}' as a boolean`);
		}
	}

	return violations;
}

/** Every required method is present. A missing one is not a capability, it is a hole. */
export function checkRequiredMethods(entry: RegisteredDeviceBackend): string[] {
	return REQUIRED_BACKEND_METHODS.filter(
		(method) => typeof entry.backend[method] !== 'function',
	).map(
		(method) => `${entry.manifest.platform}.${method} is missing — every backend must answer it`,
	);
}

/**
 * Every capability declared `true` has something to dispatch to.
 *
 * The other direction is deliberately not a violation: a capability declared `false`
 * needs no method at all, because an honest opt-out is a complete backend rather than an
 * unfinished one (ai/TESTING.md).
 */
export function checkDeclaredCapabilitiesDispatch(entry: RegisteredDeviceBackend): string[] {
	const violations: string[] = [];

	for (const capability of CAPABILITY_IDS) {
		if (!entry.manifest.capabilities[capability]) continue;
		for (const method of CAPABILITY_METHODS[capability]) {
			if (typeof entry.backend[method] !== 'function') {
				violations.push(
					`${entry.manifest.platform} declares '${capability}' but has no ${method} to dispatch it to`,
				);
			}
		}
	}

	return violations;
}

/**
 * No method present on the backend is a stub — required and gated alike, and regardless
 * of what the flag says. A stub has the right shape and passes every surface assertion,
 * so the only thing left to read is its source.
 *
 * An opt-out's method is scanned too rather than skipped: `canReadScreen: false` beside
 * a `readScreen` that throws the sentinel is a backend under construction, not a backend
 * that made a choice.
 */
export function checkNoStubbedMethods(entry: RegisteredDeviceBackend): string[] {
	const violations: string[] = [];
	const gated = CAPABILITY_IDS.flatMap((capability) => CAPABILITY_METHODS[capability]);

	for (const method of [...REQUIRED_BACKEND_METHODS, ...gated]) {
		const implementation = entry.backend[method];
		const source = readMethodSource(implementation);
		if (source === null) continue;

		const name = `${entry.manifest.platform}.${method}`;
		if (isUnreadableMethod(implementation)) {
			violations.push(
				`${name} has unreadable source (bound or mocked) — the stub scan cannot see it`,
			);
		} else if (isStubSource(source)) {
			violations.push(`${name} is a stub: its source carries the not-implemented sentinel`);
		} else if (isEmptyAnswerSource(source)) {
			violations.push(`${name} answers with an empty result instead of doing the work`);
		}
	}

	return violations;
}

/**
 * Platform ids are unique across the registry. `registerDeviceBackend()` throws on a
 * duplicate, so this is the check that says so when a registration path ever stops
 * going through it.
 */
export function checkUniquePlatformIds(entries: readonly RegisteredDeviceBackend[]): string[] {
	const seen = new Set<string>();
	const violations: string[] = [];

	for (const entry of entries) {
		const platform = entry.manifest.platform;
		if (seen.has(platform)) {
			violations.push(`platform id '${platform}' is registered by more than one backend`);
		}
		seen.add(platform);
	}

	return violations;
}

/** Every per-manifest check, for a caller that wants one verdict. */
export function collectConformanceViolations(entry: RegisteredDeviceBackend): string[] {
	return [
		...checkManifestMetadata(entry),
		...checkRequiredMethods(entry),
		...checkDeclaredCapabilitiesDispatch(entry),
		...checkNoStubbedMethods(entry),
	];
}

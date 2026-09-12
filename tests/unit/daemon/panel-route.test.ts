/**
 * R52's host half end to end: the HTTP listener serving `panel/dist` from the same origin it
 * serves the data on, with the token gate untouched in front of everything else (#293).
 *
 * The daemon suite's real-socket exception applies (`ai/TESTING.md`), and the filesystem is real
 * for `artifact-route.test.ts`'s reason: what this route serves is bytes somebody's browser opens,
 * and a mocked `fs` would prove only that the module called it. **The bundle every test here
 * serves is a `mkdtemp` one this file writes**, never the checkout's own `panel/dist` — which may
 * be stale, may be absent, and is the developer's, not this suite's. `StartDaemonOptions
 * .panelBundleRoot` is the seam that makes that possible and exists for exactly this.
 *
 * The client is `node:http`'s own `request` rather than a Rover client, because a browser is not a
 * Rover client; the listener binds `127.0.0.1:0`; the store is a real `users.json` beside the
 * bundle.
 *
 * **Four properties are the subject, and the first is the one that is easy to lose.** Route
 * precedence: a gated address never resolves to the SPA fallback, for every method the dispatcher
 * distinguishes. Containment: traversal and symlink escape refused, no directory listing. The
 * missing build: one sentence naming `npm run panel:build`, never a silent `404` and never an
 * empty page. And the auth boundary from both sides — the bundle reachable with no credential at
 * all, every gated route still refused without one, in the same bytes as before.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	_resetDeviceBackendRegistryForTesting,
	registerDeviceBackend,
} from '@/backends/registry.js';
import type { Device, DeviceBackend, DeviceWatch, DeviceWatcher } from '@/core/device.js';
import { type RunningDaemon, startDaemon } from '@/daemon/listen.js';
import { PANEL_NOT_BUILT_MESSAGE } from '@/daemon/panel-bundle.js';
import {
	createTempSocket,
	isSweepLogLine,
	removeTempSocket,
	type TempSocket,
} from '../../helpers/daemon-socket.js';
import { createMockDevice, createMockDeviceBackend } from '../../helpers/factories.js';
import { createTestUserStore, type TestUserStore } from '../../helpers/user-store.js';

/**
 * The one refusal body, spelled out here rather than imported, exactly as `http-listener.test.ts`
 * spells it out: a copy is what makes it a contract. **This is the assertion that says the static
 * route widened nothing** — a gated address answers the identical bytes it answered before this
 * route existed.
 */
const REFUSAL_BODY = JSON.stringify({
	type: 'error',
	protocolVersion: 1,
	id: null,
	error: { code: 'unauthenticated', message: 'Authentication failed.' },
});

/** What the built bundle holds in these tests — one document, one script, one stylesheet. */
const INDEX_HTML = '<!doctype html>\n<html><body><div id="root"></div></body></html>\n';
const SCRIPT = 'console.log("the panel");\n';
const STYLESHEET = ':root { color: red }\n';
/** Vite's own hashed names, so the assertions are about addresses a real build produces. */
const SCRIPT_NAME = 'index-DEi3STMG.js';
const STYLESHEET_NAME = 'index-By8w7xDU.css';

let temp: TempSocket;
let store: TestUserStore;
/** The `mkdtemp` bundle root, which is never the checkout's `panel/dist`. */
let bundleRoot: string;
/** Everything the reader said on the host. Spied rather than injected: the daemon builds it. */
let warnings: string[];
const running: RunningDaemon[] = [];

beforeEach(async () => {
	temp = await createTempSocket();
	store = await createTestUserStore(temp.dir);
	bundleRoot = await mkdtemp(join(tmpdir(), 'rover-panel-dist-'));
	warnings = [];
	// The daemon runs a full pass of its retention policy as it comes up (D38) and writes to this
	// same log, at a moment nothing here sequences — dropped at the spy, as `artifact-route.test.ts`
	// drops it, so what is counted below is this suite's own subject.
	vi.spyOn(console, 'warn').mockImplementation((line: string) => {
		if (!isSweepLogLine(line)) {
			warnings.push(line);
		}
	});
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(running.splice(0).map((daemon) => daemon.close()));
	_resetDeviceBackendRegistryForTesting();
	await rm(bundleRoot, { recursive: true, force: true });
	if (temp) {
		await removeTempSocket(temp);
	}
});

/**
 * A backend has to be registered before `startDaemon`, because the daemon builds its inventory on
 * start. Nothing here drives a device — this suite is about files on the host — so one idle fake
 * is all it needs.
 */
function registerFakeBackend(devices: Device[] = [createMockDevice()]) {
	registerDeviceBackend({
		manifest: {
			platform: 'test-platform',
			label: 'Test',
			capabilities: {
				canReadScreen: true,
				canInput: true,
				canControlNetwork: true,
				canRecordVideo: true,
				canControlRecording: true,
			},
		},
		backend: createMockDeviceBackend({
			watchDevices: vi.fn<DeviceBackend['watchDevices']>((watcher: DeviceWatcher) => {
				watcher.onDevices(devices);
				return { stop: vi.fn<DeviceWatch['stop']>(async () => {}) };
			}),
			describeDevice: async (serial) => createMockDevice({ serial }),
		}),
	});
}

/** `npm run panel:build`, as far as this suite is concerned: a document and Vite's `assets/`. */
async function writeBundle(): Promise<void> {
	await mkdir(join(bundleRoot, 'assets'), { recursive: true });
	await writeFile(join(bundleRoot, 'index.html'), INDEX_HTML);
	await writeFile(join(bundleRoot, 'assets', SCRIPT_NAME), SCRIPT);
	await writeFile(join(bundleRoot, 'assets', STYLESHEET_NAME), STYLESHEET);
}

/** A daemon on the temp socket with the HTTP listener up beside it, and its port. */
async function start(): Promise<number> {
	registerFakeBackend();
	const result = await startDaemon({
		socketPath: temp.socketPath,
		artifactsRoot: temp.artifactsRoot,
		projectsRoot: temp.projectsRoot,
		keptTestsPath: temp.keptTestsPath,
		retention: temp.retention,
		panelBundleRoot: bundleRoot,
		http: { address: '127.0.0.1', port: 0, usersPath: store.path },
	});
	if (!result.started) {
		throw new Error('Another daemon holds the temp socket — the test cannot proceed');
	}
	running.push(result);
	if (result.httpPort === null) {
		throw new Error('The daemon opened no HTTP listener');
	}
	return result.httpPort;
}

/** A daemon with a bundle already built, which is what most of these tests want. */
async function startServed(): Promise<number> {
	await writeBundle();
	return start();
}

interface Answer {
	readonly status: number;
	readonly headers: IncomingHttpHeaders;
	readonly body: string;
}

interface Call {
	readonly port: number;
	readonly path: string;
	readonly method?: string;
	/** Omitted entirely when absent, so "no credential at all" is reachable. */
	readonly authorization?: string;
}

/**
 * One request, over Node's own client rather than over `fetch`.
 *
 * Deliberately the low-level one, for `http-listener.test.ts`'s reason: this suite has to send a
 * request with no `Authorization` header at all and a raw, **un-normalised** path — `fetch` and
 * `URL` both collapse `..` before it ever reaches the wire, which would make every traversal case
 * here assert nothing.
 */
function send(options: Call): Promise<Answer> {
	return new Promise<Answer>((resolve, reject) => {
		const request = httpRequest(
			{
				host: '127.0.0.1',
				port: options.port,
				path: options.path,
				method: options.method ?? 'GET',
				headers:
					options.authorization === undefined ? {} : { authorization: options.authorization },
			},
			(response: IncomingMessage) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () =>
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString('utf8'),
					}),
				);
			},
		);
		request.on('error', reject);
		request.end();
	});
}

describe('the host serves the panel from the same origin as the data', () => {
	it('answers GET / with the built document', async () => {
		const port = await startServed();

		const answer = await send({ port, path: '/' });

		expect(answer.status).toBe(200);
		expect(answer.body).toBe(INDEX_HTML);
		expect(answer.headers['content-type']).toBe('text/html; charset=utf-8');
	});

	it('answers the built bundle with no credential at all', async () => {
		const port = await startServed();

		// No `authorization` key whatsoever — not an empty one, which is a different case.
		const document = await send({ port, path: '/' });
		const script = await send({ port, path: `/assets/${SCRIPT_NAME}` });

		expect(document.status).toBe(200);
		expect(script.status).toBe(200);
		expect(script.body).toBe(SCRIPT);
	});

	it('serves each asset as the type its extension names, un-sniffable and un-cached', async () => {
		const port = await startServed();

		const script = await send({ port, path: `/assets/${SCRIPT_NAME}` });
		const stylesheet = await send({ port, path: `/assets/${STYLESHEET_NAME}` });

		expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
		expect(stylesheet.headers['content-type']).toBe('text/css; charset=utf-8');
		// A bundle a browser may sniff past is a bundle whose type this host only suggested, and
		// the daemon is upgraded under tabs that have been open for a week.
		for (const answer of [script, stylesheet]) {
			expect(answer.headers['x-content-type-options']).toBe('nosniff');
			expect(answer.headers['cache-control']).toBe('no-store');
		}
	});

	it.each([
		['/archive', 'the archive browser'],
		['/groups', 'the testing-groups view'],
		['/projects', 'the projects screen'],
		['/archive/', 'the same address with a trailing slash'],
	])('falls back to index.html for %s, which is %s', async (path) => {
		const port = await startServed();

		const answer = await send({ port, path });

		expect(answer.status).toBe(200);
		expect(answer.body).toBe(INDEX_HTML);
	});

	/**
	 * The case an extension heuristic would get wrong, and the reason `panel-bundle.ts` does not
	 * use one: `/archive/$` is a real client route and the preview extends it with the artifact's
	 * own file name, so a path ending in `.png` here is a **page**.
	 */
	it('falls back for a client route carrying an artifact file name', async () => {
		const port = await startServed();

		const answer = await send({
			port,
			path: '/archive/checkout-app/login-flow/run/serial/screenshots/001_screenshot.png',
		});

		expect(answer.status).toBe(200);
		expect(answer.body).toBe(INDEX_HTML);
	});

	/**
	 * And the case that must **not** fall back: a hashed asset answered with a document fails in
	 * the browser as a syntax error inside a bundle that looks present, which is the worst
	 * diagnosis available in this whole change.
	 */
	it('answers 404 for a missing build asset rather than handing back a document', async () => {
		const port = await startServed();

		const answer = await send({ port, path: '/assets/index-GONE.js' });

		expect(answer.status).toBe(404);
		expect(answer.body).not.toContain('<!doctype html>');
		expect(answer.headers['content-type']).toBe('text/plain; charset=utf-8');
	});
});

describe('route precedence is stated, not a consequence of ordering', () => {
	/**
	 * The whole point of `routeFor`: every method on every host address, including the verbs those
	 * addresses do not take, and none of them may become the panel's document.
	 */
	it.each([
		['POST', '/rpc'],
		['GET', '/rpc'],
		['PUT', '/rpc'],
		['DELETE', '/rpc'],
		['POST', '/session'],
		['GET', '/session'],
		['DELETE', '/session'],
		['PUT', '/session'],
		['GET', '/artifact'],
		['POST', '/artifact'],
		['GET', '/artifact/project/test/run/serial/screenshots/001.png'],
		['POST', '/artifact/project/test/run/serial/screenshots/001.png'],
		['PUT', '/artifact/project/test/run/serial/screenshots/001.png'],
	])('never resolves %s %s to the SPA fallback', async (method, path) => {
		const port = await startServed();

		const answer = await send({ port, path, method });

		expect(answer.body).not.toContain('<!doctype html>');
		expect(answer.headers['content-type']).not.toBe('text/html; charset=utf-8');
	});

	/**
	 * The same set from the other side: with no credential every one of them is the one refusal,
	 * byte for byte — the property `http-listener.test.ts` pinned before this route existed, and
	 * the one the static route had the most opportunity to erode.
	 */
	it.each([
		['POST', '/rpc'],
		['GET', '/rpc'],
		['DELETE', '/rpc'],
		['GET', '/session'],
		['DELETE', '/session'],
		['PUT', '/session'],
		['GET', '/artifact'],
		['POST', '/artifact'],
		['GET', '/artifact/project/test/run/serial/screenshots/001.png'],
		['POST', '/artifact/project/test/run/serial/screenshots/001.png'],
	])('refuses %s %s without a credential, in the same bytes as ever', async (method, path) => {
		const port = await startServed();

		const answer = await send({ port, path, method });

		expect(answer.status).toBe(401);
		expect(answer.body).toBe(REFUSAL_BODY);
	});

	/**
	 * A `POST` to an address the panel owns is not a page either. The bundle is a `GET` route and
	 * everything else is the uniform refusal, so there is no verb that turns a document into a
	 * write target.
	 */
	it.each([
		['POST', '/'],
		['PUT', '/archive'],
		['DELETE', `/assets/${SCRIPT_NAME}`],
	])('refuses %s %s rather than answering the bundle', async (method, path) => {
		const port = await startServed();

		const answer = await send({ port, path, method });

		expect(answer.status).toBe(401);
		expect(answer.body).toBe(REFUSAL_BODY);
	});

	/** A signed-in browser reaches the surface exactly as it did: the gate is where it was. */
	it('still answers a credentialled call on the gated surface', async () => {
		const port = await startServed();

		const answer = await send({
			port,
			path: '/session',
			authorization: `Bearer ${store.token}`,
		});

		expect(answer.status).toBe(200);
		expect(JSON.parse(answer.body)).toMatchObject({ identifier: store.identifier });
	});
});

describe('nothing escapes the panel bundle root', () => {
	it('refuses a symlink inside the root that resolves out of it, and serves none of it', async () => {
		await writeBundle();
		const secret = join(temp.dir, 'outside.txt');
		await writeFile(secret, 'SECRET-BYTES-OUTSIDE-THE-ROOT');
		const link = join(bundleRoot, 'assets', 'escape.js');
		await symlink(secret, link);
		const port = await start();

		const answer = await send({ port, path: '/assets/escape.js' });

		expect(answer.status).toBe(404);
		expect(answer.body).not.toContain('SECRET-BYTES');
		// Nor may it become the SPA fallback: *something is there and this host will not serve it*
		// is a refusal, and answering a document for one would turn it into a `200`.
		expect(answer.body).not.toContain('<!doctype html>');
		// The diagnosis the answer may not carry lives on the host instead (D19).
		expect(warnings.join('\n')).toContain(link);
		expect(warnings.join('\n')).toContain('outside the panel bundle root');
	});

	it('refuses a symlink out of the root at an address that would otherwise fall back', async () => {
		await writeBundle();
		await writeFile(join(temp.dir, 'outside'), 'SECRET-BYTES-OUTSIDE-THE-ROOT');
		await symlink(join(temp.dir, 'outside'), join(bundleRoot, 'escape'));
		const port = await start();

		const answer = await send({ port, path: '/escape' });

		expect(answer.status).toBe(404);
		expect(answer.body).not.toContain('SECRET-BYTES');
		expect(answer.body).not.toContain('<!doctype html>');
	});

	it('still serves a symlink that points back inside the root — containment, not a ban', async () => {
		await writeBundle();
		await symlink(join(bundleRoot, 'assets', SCRIPT_NAME), join(bundleRoot, 'assets', 'alias.js'));
		const port = await start();

		const answer = await send({ port, path: '/assets/alias.js' });

		expect(answer.status).toBe(200);
		expect(answer.body).toBe(SCRIPT);
	});

	it.each([
		['a raw traversal', '/../../../etc/passwd'],
		['an encoded traversal', '/%2e%2e/%2e%2e/etc/passwd'],
		['an encoded separator', '/assets%2f..%2f..%2fetc%2fpasswd'],
		['a NUL', '/assets/index%00.js'],
		['a bare dot', '/./index.html'],
	])('refuses %s, and reads nothing outside the root', async (_what, path) => {
		const port = await startServed();

		const answer = await send({ port, path });

		expect(answer.status).toBe(404);
		// A refused address is not a client route, so it gets no document either.
		expect(answer.body).not.toContain('<!doctype html>');
		expect(answer.body).not.toContain('root:');
	});

	it.each([
		['without a trailing slash', '/assets'],
		['with one', '/assets/'],
	])('lists no directory %s', async (_what, path) => {
		const port = await startServed();

		const answer = await send({ port, path });

		expect(answer.status).toBe(404);
		expect(answer.body).not.toContain(SCRIPT_NAME);
		expect(answer.body).not.toContain(STYLESHEET_NAME);
		expect(warnings.join('\n')).toContain('not a regular file');
	});
});

describe('a host with no built panel says so', () => {
	it.each([
		['the document', '/'],
		['a client route', '/archive'],
		['a build asset', `/assets/${SCRIPT_NAME}`],
	])('answers %s with one sentence naming the build command', async (_what, path) => {
		// Nothing writes the bundle: the root is an empty `mkdtemp`, which is the *empty
		// `panel/dist`* half of this case.
		const port = await start();

		const answer = await send({ port, path });

		expect(answer.body).toBe(PANEL_NOT_BUILT_MESSAGE);
		expect(answer.body).toContain('npm run panel:build');
		// Never a silent 404, and never an empty page: the status says *this host, this part of
		// it, not yet*, and the body is the sentence rather than nothing at all.
		expect(answer.status).toBe(503);
		expect(answer.body.trim().length).toBeGreaterThan(0);
	});

	it('says the same for a root that does not exist at all', async () => {
		await rm(bundleRoot, { recursive: true, force: true });
		const port = await start();

		const answer = await send({ port, path: '/' });

		expect(answer.status).toBe(503);
		expect(answer.body).toBe(PANEL_NOT_BUILT_MESSAGE);
	});

	it('says the same for the zero-byte index.html an interrupted build leaves behind', async () => {
		await writeBundle();
		await writeFile(join(bundleRoot, 'index.html'), '');
		const port = await start();

		const answer = await send({ port, path: '/' });

		expect(answer.status).toBe(503);
		expect(answer.body).toBe(PANEL_NOT_BUILT_MESSAGE);
	});

	it('leaves the gated surface exactly as it is', async () => {
		const port = await start();

		const answer = await send({ port, path: '/rpc', method: 'POST' });

		expect(answer.status).toBe(401);
		expect(answer.body).toBe(REFUSAL_BODY);
	});

	/** Re-read per request, so building while a host is up takes effect on the next reload. */
	it('serves the bundle as soon as it is built, with no restart', async () => {
		const port = await start();
		expect((await send({ port, path: '/' })).status).toBe(503);

		await writeBundle();

		const answer = await send({ port, path: '/' });
		expect(answer.status).toBe(200);
		expect(answer.body).toBe(INDEX_HTML);
	});
});

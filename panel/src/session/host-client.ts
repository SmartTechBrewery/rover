import { z } from 'zod';

/**
 * The browser's side of the host's HTTP surface: the three `/session` verbs, `POST /rpc`, and the
 * archive's byte route `GET /artifact/…`.
 *
 * **Relative URLs only, everywhere.** The panel is served by the machine it talks to, so all three
 * paths are same-origin in production and there is nothing here to configure — no host field
 * on the sign-in screen (`docs/DESIGN.md` §8), no base URL, no environment variable. In development
 * the panel's own dev server proxies them (`panel/vite.config.ts`), which is what keeps
 * this file free of the one thing an absolute URL would bring with it: somewhere for a credential to
 * be attached to a request that is not this host's.
 *
 * **The credential is a header the page sets, and it is never in a URL, a cookie or a log** (D20,
 * D30). `Authorization: Bearer <session>` — the same header a raw token goes in, so a `curl` recipe
 * and the panel present themselves identically. `credentials: 'omit'` makes the cookie half
 * structural rather than incidental: the host sets no cookie and reads none, and a browser cannot
 * attach a header of its own accord to a cross-site request, which is why this surface has no CSRF
 * question to answer. Nothing in this module logs — not a request, not a refusal — because the only
 * interesting thing to log about a refused request is the credential that was tried.
 *
 * **A refusal is a value, not a thrown string.** Every call answers {@link HostAnswer}, so a `401`
 * is something a caller has to decide about rather than something that unwinds into a `catch` where
 * a network fault and a dead session look the same. The two are distinguished on purpose: the
 * provider clears a stored session on a `refused` and *keeps* it on an `unanswered`, because a host
 * that did not answer has said nothing about whether the session is still good.
 *
 * **The session id is a parameter, never module state.** A `let session` here would be a second
 * place a live credential lives, kept in step with the provider's by hand, and it would survive a
 * sign-out for as long as nobody remembered to clear it. `session-provider.tsx` is the one holder.
 */

/** Who the host says this credential belongs to. Never used to attribute a lease (D20). */
const IdentitySchema = z.object({
	identifier: z.string().min(1),
	displayName: z.string().min(1),
});
export type HostIdentity = z.infer<typeof IdentitySchema>;

/** `POST /session`'s answer: the identity, plus the one place the raw id is ever handed out. */
const MintedSessionSchema = IdentitySchema.extend({ session: z.string().min(1) });
export type MintedSession = z.infer<typeof MintedSessionSchema>;

/** `DELETE /session` answers `{}`: there is nothing in it to read, only that it arrived. */
const AcknowledgementSchema = z.object({}).transform(() => null);

/**
 * The response envelope, as much of it as the panel reads.
 *
 * Deliberately declared here rather than imported from `src/ipc/protocol.ts`: the panel is a
 * separate tree with its own `tsconfig.json` and its own `@panel` alias precisely so one alias never
 * means two trees (`vitest.config.ts`), and the daemon's module would drag its whole neighbourhood
 * into a browser bundle. What is duplicated is two field names on a versioned wire format, and
 * `tests/unit/daemon/http-listen.test.ts` is what pins the host's half of it.
 */
const ResponseEnvelopeSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('result'), result: z.unknown() }),
	z.object({
		type: z.literal('error'),
		error: z.object({ code: z.string(), message: z.string() }),
	}),
]);

/** What the surface answered, once the transport agreed there was an answer. */
export type RpcEnvelope = z.infer<typeof ResponseEnvelopeSchema>;

/**
 * Why a request produced no value.
 *
 * - `refused` — the host answered `401`. It is the same byte-identical refusal for a credential
 *   nobody holds, a revoked user's, a malformed one, an unreadable store and a path that does not
 *   exist, so this says *that* the host declined and can never say which (D29). The screen must not
 *   dress it up as more than that.
 * - `unanswered` — nothing usable came back: the request never reached a host, or what returned was
 *   not the shape this surface promises. A stored session survives one of these.
 *
 * **A request the caller abandoned is an `unanswered`** — a host that accepted the connection and
 * said nothing inside the caller's own budget has told this browser exactly as much as one that was
 * never there. Nothing here sets that budget: the caller that owns the deadline is the caller that
 * passes the signal (#125).
 */
export type HostRefusal = 'refused' | 'unanswered';

export type HostAnswer<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly refusal: HostRefusal };

const SESSION_PATH = '/session';
const RPC_PATH = '/rpc';

/**
 * The archive's byte route (R37, #131), one archive path component per segment.
 *
 * Singular and `/artifact/`, not `/archive/`: the panel owns the client route `/archive`, and the
 * host is same-origin in production — `src/daemon/http-listen.ts` says the same thing from the
 * other side.
 */
const ARTIFACT_PATH_PREFIX = '/artifact/';

/**
 * What `GET /artifact/…` said about one file, in **`list_archive`'s own three words**.
 *
 * The archive answers with one vocabulary on both of its reads, which is why *missing* and
 * *unreadable* are named here rather than folded into {@link HostRefusal}: a file that is not there
 * and a file this host will not serve are facts about the archive, and the reader has to be told
 * them apart (`docs/DESIGN.md` §9). `HostAnswer`'s failure half stays what it is everywhere else —
 * about the credential and the connection — so a `404` arrives as a value, exactly as an `error`
 * envelope does on `POST /rpc`.
 */
export type ArchivedFile =
	| { readonly outcome: 'read'; readonly text: string }
	| { readonly outcome: 'missing' }
	| { readonly outcome: 'unreadable' };

/**
 * Exchange the token an operator issued for a session this browser may hold (D30).
 *
 * The token is a request body and reaches nothing else here: it is not stored, not returned, not
 * put in a URL and not held after this call returns.
 */
export async function signIn(token: string): Promise<HostAnswer<MintedSession>> {
	return await ask(MintedSessionSchema, SESSION_PATH, { method: 'POST', body: { token } });
}

/**
 * `GET /session` — the boot probe. Is this id still accepted, and who is it?
 *
 * It is also what renews the session's idle window on the host, so the answer is the identity the
 * `Profile` screen shows rather than a bare yes.
 */
export async function whoAmI(session: string): Promise<HostAnswer<HostIdentity>> {
	return await ask(IdentitySchema, SESSION_PATH, { method: 'GET', session });
}

/**
 * `DELETE /session` — end the session **on the host**, which is what makes signing out real rather
 * than a `clearStoredSession()` with a live credential left behind it.
 */
export async function signOut(session: string): Promise<HostAnswer<null>> {
	return await ask(AcknowledgementSchema, SESSION_PATH, { method: 'DELETE', session });
}

/**
 * One call on the panel's surface: `POST /rpc`, carrying the envelope every other Rover transport
 * carries (D29).
 *
 * The result is left as `unknown` for the caller to parse against the schema of the method it
 * asked for — this module knows about credentials and transports, and deliberately not about
 * `list_devices`. An `error` envelope is a `200` with something to read, so it arrives as a value
 * here and not as a refusal: `HostAnswer`'s failure half is about the credential and the connection,
 * and the two vocabularies must not be collapsed into one (D29's "exactly two statuses — read the
 * envelope").
 *
 * `signal` is optional and there is deliberately no default: a repeating caller has an interval to
 * spend and gives this request that budget, while a person waiting on one answer has none to give.
 * The three `/session` verbs above take none for the same reason.
 */
export async function rpc(
	session: string,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<HostAnswer<RpcEnvelope>> {
	return await ask(ResponseEnvelopeSchema, RPC_PATH, {
		method: 'POST',
		session,
		body: { protocolVersion: 1, id: nextRequestId(), method, params },
		...(signal === undefined ? {} : { signal }),
	});
}

/**
 * One archived file, read as **text** — `GET /artifact/<component>/…`.
 *
 * **Text, and deliberately not bytes.** The one thing the panel reads the body of is a small JSON
 * file the archive writes itself (`device_info.json`, `PROJECT.md` §10); a screenshot or a
 * recording is never read here at all, because a browser renders those from the URL — an `<img>`
 * or a `<video>` fetches its own subresource, which is what the route's content type and its
 * `Range` support exist for. So there is no `ArrayBuffer` variant to keep in step, and nothing here
 * pulls a video into a string.
 *
 * **The address is the components a listing answered**, one per segment, each encoded — never a
 * path this browser composed and never anything resembling a host filesystem path (D19). The route
 * decodes per segment and re-validates with the archive's own `ArchivePathSegmentSchema`, so a `/`
 * or a `..` inside a component is refused there rather than smuggled through as an already-encoded
 * string.
 *
 * The credential is the same header everything else on this surface carries, for the same reasons:
 * never in the URL, never a cookie, never logged.
 */
export async function readArtifactText(
	session: string,
	path: readonly string[],
): Promise<HostAnswer<ArchivedFile>> {
	let response: Response;
	try {
		response = await fetch(addressOf(path), {
			method: 'GET',
			headers: headersFor({ method: 'GET', session }),
			cache: 'no-store',
			credentials: 'omit',
		});
	} catch {
		return { ok: false, refusal: 'unanswered' };
	}

	if (response.status === 401) {
		return { ok: false, refusal: 'refused' };
	}
	if (response.status === 404) {
		return { ok: true, value: { outcome: 'missing' } };
	}
	if (!response.ok) {
		// A `400` (an address no listing could have answered) and a `500` (something is filed there
		// and the host will not serve it) both land here. The panel can say *that* the file could
		// not be read and never why — the reason and the path stay on the host by design, which is
		// why neither of those bodies carries one to read.
		return { ok: true, value: { outcome: 'unreadable' } };
	}

	try {
		return { ok: true, value: { outcome: 'read', text: await response.text() } };
	} catch {
		// The headers arrived and the body did not. Nothing was read, so this is the transport's
		// failure rather than the archive's, and a half-read file must never be parsed as a whole one.
		return { ok: false, refusal: 'unanswered' };
	}
}

/** `/artifact/a/b/c`, each component encoded on its own so a separator inside one cannot escape it. */
function addressOf(path: readonly string[]): string {
	return `${ARTIFACT_PATH_PREFIX}${path.map((component) => encodeURIComponent(component)).join('/')}`;
}

interface HostRequest {
	readonly method: 'GET' | 'POST' | 'DELETE';
	readonly session?: string;
	readonly body?: unknown;
	/** Abandons the request. Its abort lands in the `catch` below as an `unanswered`. */
	readonly signal?: AbortSignal;
}

/**
 * One request, one answer, and every failure narrowed to {@link HostRefusal} before a caller sees
 * it.
 *
 * `cache: 'no-store'` is the browser's half of the `cache-control: no-store` the host already sends
 * on all three `/session` verbs: neither a credential nor an identity is something a back button or
 * a proxy may keep a copy of.
 */
async function ask<S extends z.ZodTypeAny>(
	schema: S,
	path: string,
	request: HostRequest,
): Promise<HostAnswer<z.output<S>>> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: request.method,
			headers: headersFor(request),
			body: request.body === undefined ? undefined : JSON.stringify(request.body),
			cache: 'no-store',
			credentials: 'omit',
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
	} catch {
		// No host answered — it is not running, not reachable, the request was cut off, or the
		// caller abandoned it on its own deadline. Says nothing at all about the credential, which
		// is why it is not a `refused`.
		return { ok: false, refusal: 'unanswered' };
	}

	if (response.status === 401) {
		return { ok: false, refusal: 'refused' };
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return { ok: false, refusal: 'unanswered' };
	}

	const parsed = schema.safeParse(body);
	return parsed.success ? { ok: true, value: parsed.data } : { ok: false, refusal: 'unanswered' };
}

function headersFor(request: HostRequest): Record<string, string> {
	return {
		...(request.session === undefined ? {} : { authorization: `Bearer ${request.session}` }),
		...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
	};
}

let requests = 0;

/**
 * The envelope's `id`, which HTTP does not need: one request is one response on this transport, so
 * correlation is the connection's own. It exists because the envelope is shared with a transport
 * where several requests are in flight on one stream, and the host echoes it back.
 */
function nextRequestId(): string {
	requests += 1;
	return String(requests);
}

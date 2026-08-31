/**
 * A project's helper services — what the host runs *for* a lease, started at grant time
 * (D13, R17 phase 4).
 *
 * **The `./project-install.ts` shape, at the other end of a lease.** `./project-hooks.ts`
 * reads and parses, so anything may import it; `./hook-command.ts` is the only module that
 * starts a process; and this one joins the two for the services a grant brings up. The stops a
 * lease's *end* runs are somewhere else on purpose: they belong to the restoration, which
 * already runs on release **and** on expiry, contains every step and needs no help from a
 * caller (D9, `./project-resolver.ts`). The only stops here are a refused grant's own — see
 * below.
 *
 * **A start that fails refuses the grant.** Handing back a lease on a device whose helper
 * services are down is a false yes — the plausible-looking answer `ai/RULES.md` §2 forbids — so
 * {@link ProjectServices.start} answers with a refusal naming the service, and
 * `./lease-handlers.ts` turns that into `'service-failed'` data rather than an IPC error. It
 * **never throws**, for the reason that matters most about where it is called from: by then the
 * lease has been inserted, and a throw would become `internal_error`, leaving the caller without
 * a lease id and the device wedged for the whole TTL.
 *
 * **Anything already started for a refused grant is stopped again**, in the reverse of the order
 * it came up in, before the refusal is answered. A grant that failed half way through would
 * otherwise leave a project's first two services running with no lease to ever stop them.
 *
 * **A start is bounded, and the service is not.** A start is an ordinary hook command, so
 * `HOOK_COMMAND_TIMEOUT_MS` bounds it like any other; a service meant to outlive the command
 * that started it is the project's own business, exactly as it is for a teardown that
 * backgrounds a helper (`./hook-command.ts`). What is bounded here in addition is the *whole*
 * phase — see {@link SERVICE_START_TIMEOUT_MS} — because this wait sits inside a grant. The
 * rollback above draws on that same budget rather than on a fresh one per stop: it is what the
 * caller is waiting through before the refusal reaches it, so a rollback outside the bound is a
 * `service-failed` answer that arrives after the client's request timeout has already turned it
 * into an opaque host error.
 *
 * **Nothing is cached** (D6), for `./project-resolver.ts`'s reason: the file is re-read on every
 * grant, so an operator editing a project's services changes what the next lease on it starts
 * with the daemon still running.
 *
 * **A grant's services belong to that grant, and the slot is what keeps them apart.** Two
 * devices can be leased for one project at once, and both grants run the same declared `start`
 * commands against the same host. What stops those from being one shared set is R18: each lease
 * has a slot, and every hook child is told its index and its port block (`./slots.ts`,
 * `./hook-command.ts`), so a `start`/`stop` pair that namespaces by `ROVER_SLOT` brings up one
 * instance per lease and the restoration takes down that lease's own (`./restore.ts`). A pair
 * that ignores it addresses a single shared instance instead — the second grant then gets
 * whatever the first brought up, and the first lease to end takes it away from the other. That
 * is the project's contract to keep and not something the host can check: these are opaque
 * commands, and nothing here can read one and tell which shape it is. `README.md`'s "Project
 * hooks" says so where an operator writing the file will see it.
 *
 * **This module hands out nothing.** It starts and stops what the project declares; the ports a
 * service may use come from the lease's slot, which is allocated by the grant before this runs
 * and reaches a start only as the environment `./hook-command.ts` sets (R18).
 */

import type { LeaseId } from '../core/ids.js';
import type { HookCommandContext } from './hook-command.js';
import { HOOK_COMMAND_TIMEOUT_MS, runHookCommand } from './hook-command.js';
import type { Lease } from './leases.js';
import type { ProjectService } from './project-hooks.js';
import { readProjectHooks } from './project-hooks.js';

/**
 * How long *all* of a project's service starts may take together before the grant is refused.
 *
 * The bound is on the phase rather than only on each command, because the number it has to sit
 * under belongs to neither: `DEFAULT_REQUEST_TIMEOUT_MS` is 30 s (`src/ipc/client.ts`) and
 * `acquire_device` is the one call no client raises it for — `rover acquire` and the MCP tool
 * both take the default. Eight seconds per command (`HOOK_COMMAND_TIMEOUT_MS`) times
 * `MAX_PROJECT_SERVICES` is a minute, so a per-command bound alone would let a slow project
 * answer a grant long after the caller had given up — and a grant nobody is listening for still
 * holds the device for a full `LEASE_TTL_MS`, which is the failure `SETTLE_TIMEOUT_MS`
 * (`./restore.ts`) is written about.
 *
 * Twenty seconds, so it is under that 30 s with room for the answer to travel, and each command
 * gets whatever is left of it rather than a fresh eight seconds. Both relationships are asserted
 * in `tests/unit/daemon/project-services.test.ts` rather than left to drift, the way
 * `HOOK_COMMAND_TIMEOUT_MS` is asserted against the restorer's own bound. It is not the whole of a
 * grant's wait — a grant also waits out the previous lessee's restoration — which is why a start
 * has to be a *start*: readiness probes and health checks are explicitly not this row (R18 and
 * beyond), and a start that waits for a service to be ready is a start that spends this budget.
 *
 * **The refusal path shares it, stops included.** The rollback of a refused grant is inside the
 * wait the caller is doing, so giving each of its stops a fresh `HOOK_COMMAND_TIMEOUT_MS` would
 * let `MAX_PROJECT_SERVICES - 1` of them run *past* this bound: a project with several slow
 * `stop` commands and one failing `start` would answer `'service-failed'` after the client had
 * already given up, which loses the named service this row exists to deliver and holds the
 * device for the whole overrun. So the deadline is taken once, before the first start, and every
 * command below it — start and rollback stop alike — gets whatever is left of it. A stop reached
 * with nothing left is **warned about rather than run**: the alternative is a program spawned
 * with no time to finish, and the honest answer is that the service may still be running.
 */
export const SERVICE_START_TIMEOUT_MS = 20_000;

/** Why a grant is being refused, and which service is the reason. */
export interface ServiceStartRefusal {
	/**
	 * The service that did not start, or `null` when the hook file itself could not be read —
	 * there is no service to name in that case, and the message names the file instead.
	 */
	readonly service: string | null;
	/** The sentence the refusal carries. Names the device, the project and what happened. */
	readonly message: string;
}

export interface ProjectServices {
	/**
	 * Start what this lease's project declares, in declaration order.
	 *
	 * `null` when everything started, and equally when the project declares no services or has
	 * no hook file at all — a project nobody has described is the ordinary state of a host. A
	 * refusal means nothing this call started is still running: it stops what it brought up,
	 * newest first, before answering.
	 *
	 * **Never throws**, including for a hook file that will not parse — see the module header.
	 */
	start(lease: Lease): Promise<ServiceStartRefusal | null>;
	/**
	 * What this lease has running, as far as the daemon knows — the record {@link forget} drops.
	 *
	 * A question in the spirit of `LeaseStore.holderOf`: it starts nothing and stops nothing. It
	 * is here because the record is host state that must not outlive the lease it belongs to, and
	 * a claim of that shape is worth being able to check.
	 *
	 * **It is deliberately not what decides what gets stopped.** That is the hook file, re-read
	 * by the restoration at the moment the lease ends, so an operator's edit bites the next lease
	 * out with nothing restarted (D6, `./project-resolver.ts`). Answering it from this record
	 * instead would cache the file in host state for a whole lease — the one thing D6 says not to
	 * do — and it would still be the wrong answer for the lease that was granted before the
	 * services were declared.
	 */
	startedFor(lease: Lease): readonly string[];
	/**
	 * The lease ended: drop its record.
	 *
	 * **It stops nothing, and it is not what stops the services.** The restoration is — it
	 * re-reads the hook file (D6) and stops what the project declares, ahead of the teardown and
	 * contained step by step, on release and on expiry alike (`./restore.ts`, D9). So this is
	 * bookkeeping, exactly as `ArtifactArchive.forget` is: without it the host would grow with
	 * the number of leases it has ever granted.
	 *
	 * Synchronous and never throws — it hangs off the lease store's end hook, which requires
	 * both (`./leases.ts`).
	 */
	forget(lease: Lease): void;
}

export interface ProjectServicesOptions {
	/** Where the hook files are — `ROVER_PROJECTS_PATH`, resolved once in `./main.ts`. */
	readonly root: string;
	/**
	 * Defaults to `HOOK_COMMAND_TIMEOUT_MS`, and is capped by whatever is left of
	 * {@link SERVICE_START_TIMEOUT_MS} either way. A test seam in the spirit of
	 * `ProjectResolverOptions.hookTimeoutMs`, not a configuration surface.
	 */
	readonly hookTimeoutMs?: number;
	/**
	 * Defaults to {@link SERVICE_START_TIMEOUT_MS}. A test seam in the spirit of
	 * {@link hookTimeoutMs} — a real twenty-second bound and a unit test cannot both be in the
	 * same run.
	 */
	readonly startTimeoutMs?: number;
	/**
	 * Defaults to `Date.now`. Injected so a test can move the phase's clock by hand, the way
	 * `LeaseStoreOptions.now` is — a budget spent by commands that all succeeded is otherwise a
	 * race between a real timeout and a real child process, and the branch that refuses a service
	 * the budget never reached cannot be reached at all without it.
	 */
	readonly now?: () => number;
	/** Where a failing or skipped rollback stop is reported. Defaults to `console.warn`. */
	readonly warn?: (message: string) => void;
}

/** What a project declares, or the refusal that reading it produced instead. */
type Declared =
	| { readonly services: readonly ProjectService[] }
	| { readonly refusal: ServiceStartRefusal };

export function createProjectServices(options: ProjectServicesOptions): ProjectServices {
	const warn = options.warn ?? ((message: string) => console.warn(message));
	const hookTimeoutMs = options.hookTimeoutMs ?? HOOK_COMMAND_TIMEOUT_MS;
	const startTimeoutMs = options.startTimeoutMs ?? SERVICE_START_TIMEOUT_MS;
	const now = options.now ?? Date.now;

	/**
	 * What this daemon started, per live lease, in the order it came up. Keyed by lease id and
	 * dropped by `forget` — the growth bound is the whole reason it is keyed that way.
	 */
	const started = new Map<LeaseId, ProjectService[]>();

	const contextFor = (lease: Lease, timeoutMs: number): HookCommandContext => ({
		project: lease.project,
		serial: lease.serial,
		slot: lease.slot,
		timeoutMs,
	});

	/** The services `lease.project` declares, or a refusal naming the file that would not parse. */
	const declaredBy = async (lease: Lease): Promise<Declared> => {
		try {
			return { services: (await readProjectHooks(options.root, lease.project))?.services ?? [] };
		} catch (error) {
			// Refused rather than granted-anyway, and refused rather than thrown. A file the host
			// cannot read is a file whose services it cannot start, so granting would be the false
			// yes this module exists to prevent; and the operator's mistake reaches the agent as
			// something it can act on and repeat back, which `internal_error` is not.
			return {
				refusal: {
					service: null,
					message:
						`Device '${lease.serial}' was not granted: the helper services project ` +
						`'${lease.project}' declares could not be read — ${describe(error)}`,
				},
			};
		}
	};

	/**
	 * What is left of the phase for the next command, capped at one command's own bound. Never
	 * more than `hookTimeoutMs`, and `0` or less once the deadline has passed — see
	 * {@link SERVICE_START_TIMEOUT_MS} for why one deadline covers the starts and the rollback.
	 */
	const budgetLeft = (deadline: number): number => Math.min(hookTimeoutMs, deadline - now());

	/**
	 * Start each service in turn, recording what came up. The refusal, or `null`.
	 *
	 * Each command gets whatever is left of the phase budget, capped at its own — see
	 * {@link SERVICE_START_TIMEOUT_MS}. A budget that is already spent refuses by name without
	 * spawning anything, because the alternative is a command started with no time to finish.
	 */
	const startEach = async (
		lease: Lease,
		declared: readonly ProjectService[],
		running: ProjectService[],
		deadline: number,
	): Promise<ServiceStartRefusal | null> => {
		for (const service of declared) {
			const budget = budgetLeft(deadline);
			if (budget <= 0) {
				return refusalFor(
					lease,
					service.name,
					`the ${startTimeoutMs}ms all of this project's services have to start in was spent ` +
						`before it was reached`,
				);
			}
			try {
				await runHookCommand(service.start, contextFor(lease, budget));
			} catch (error) {
				return refusalFor(lease, service.name, describe(error));
			}
			running.push(service);
		}
		return null;
	};

	/**
	 * Stop what came up for a grant that is being refused, newest first — a service started
	 * after the one it depends on is stopped before it.
	 *
	 * Contained per service and never rethrown: the grant is already being refused, and a stop
	 * that failed must not stop the ones after it from being tried. A service declaring no
	 * `stop` is left alone rather than reported, which is what declaring none means.
	 *
	 * **Inside the phase deadline the starts drew on**, not a fresh bound per stop: the caller is
	 * still waiting for the refusal, so a rollback that ran past the budget would answer after the
	 * client's request timeout had already fired ({@link SERVICE_START_TIMEOUT_MS}). A stop with
	 * nothing left is warned about and skipped rather than spawned with no time to finish.
	 */
	const rollBack = async (
		lease: Lease,
		running: readonly ProjectService[],
		deadline: number,
	): Promise<string[]> => {
		const stopped: string[] = [];
		for (const service of [...running].reverse()) {
			const stop = service.stop;
			if (stop === undefined) {
				continue;
			}
			const budget = budgetLeft(deadline);
			if (budget <= 0) {
				warn(
					`Refusing device '${lease.serial}': the ${startTimeoutMs}ms this grant had to bring ` +
						`the project's helper services up and down again was spent before the '${service.name}' ` +
						`service could be stopped, so it was not tried. It may still be running.`,
				);
				continue;
			}
			try {
				await runHookCommand(stop, contextFor(lease, budget));
				stopped.push(service.name);
			} catch (error) {
				warn(
					`Refusing device '${lease.serial}': stopping the '${service.name}' helper service ` +
						`started for it failed — ${describe(error)}. It may still be running.`,
				);
			}
		}
		return stopped;
	};

	return {
		async start(lease: Lease): Promise<ServiceStartRefusal | null> {
			const declared = await declaredBy(lease);
			if ('refusal' in declared) {
				return declared.refusal;
			}
			if (declared.services.length === 0) {
				return null;
			}

			const running: ProjectService[] = [];
			// Taken here rather than inside `startEach`, so the rollback below is inside it too —
			// the refusal is what the caller is waiting for, and everything it waits through has to
			// fit under one bound ({@link SERVICE_START_TIMEOUT_MS}). Taken *after* the file read
			// for the same reason the read is not a hook: it spawns nothing, and a budget a
			// filesystem stat could spend is a budget that would refuse a project's first service
			// on a slow disk.
			const deadline = now() + startTimeoutMs;
			const refusal = await startEach(lease, declared.services, running, deadline);
			if (refusal === null) {
				// Only a grant that is going ahead leaves a record: a refused one has nothing
				// running, and the lease it would be filed under is about to end.
				started.set(lease.id, running);
				return null;
			}

			const stopped = await rollBack(lease, running, deadline);
			return stopped.length === 0
				? refusal
				: {
						service: refusal.service,
						message: `${refusal.message}. ${listStopped(stopped)}`,
					};
		},

		startedFor(lease: Lease): readonly string[] {
			return (started.get(lease.id) ?? []).map((service) => service.name);
		},

		forget(lease: Lease): void {
			started.delete(lease.id);
		},
	};
}

/** The sentence a `'service-failed'` refusal carries, in the shape every refusal here has. */
function refusalFor(lease: Lease, service: string, why: string): ServiceStartRefusal {
	return {
		service,
		message:
			`Device '${lease.serial}' was not granted: the '${service}' helper service declared by ` +
			`project '${lease.project}' did not start — ${why}`,
	};
}

/** What the refusal adds about the services this grant had already brought up. */
function listStopped(stopped: readonly string[]): string {
	const names = stopped.map((name) => `'${name}'`).join(', ');
	return stopped.length === 1
		? `The ${names} service started for this grant was stopped again`
		: `The ${names} services started for this grant were stopped again`;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

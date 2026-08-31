import { useSession } from '@panel/session/session-provider.js';
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from 'react';
import { ListDevicesResultSchema, type ListedDevice } from './device-list.js';

/**
 * The panel's one live data source: `list_devices`, polled.
 *
 * **Polling, not push** (`PROJECT.md` R32, D29). The host's surface is one route carrying the same
 * envelopes every other Rover transport carries; there is no event stream and no second connection
 * style to add one.
 *
 * It is a provider rather than a hook per screen because the reachability failure is a state of the
 * **whole page** (`docs/DESIGN.md` §3, §7): `app.tsx` renders the unreachable page in place of the
 * router, which it can only do if the poll lives above the router. The accepted cost is that the
 * device poll runs while `Profile` is open, and an unreachable host takes `Profile` down with
 * everything else — recorded in §7, because the panel has exactly one live data source and this
 * is it.
 */

export const POLL_MS = 5_000;

export type DeviceListState =
	/** Nothing has come back yet. It is not an empty list and must never render as one. */
	| { readonly status: 'loading' }
	| {
			readonly status: 'ready';
			readonly devices: readonly ListedDevice[];
			readonly stale: boolean;
			/**
			 * This browser's clock when the answer was parsed. The countdown's base, and the only
			 * place local time touches host data (`countdown.ts`).
			 */
			readonly receivedAtMs: number;
	  }
	/** Nothing usable came back. A state of the whole page, never a widget beside the nav. */
	| { readonly status: 'unreachable' };

export interface DeviceList {
	readonly state: DeviceListState;
	/** Ask again now. What `RETRY CONNECTION` calls; the interval keeps running either way. */
	readonly refresh: () => void;
}

const DeviceListContext = createContext<DeviceList | undefined>(undefined);

export function DeviceListProvider({ children }: { readonly children: ReactNode }) {
	const { call } = useSession();
	const [state, setState] = useState<DeviceListState>({ status: 'loading' });

	// A tick that arrives while a request is still out is dropped rather than queued, so a host
	// slower than the interval cannot have requests stacked on it.
	const asking = useRef(false);
	const live = useRef(true);

	const read = useCallback(async (): Promise<void> => {
		if (asking.current) {
			return;
		}
		asking.current = true;
		try {
			const answer = await call('list_devices', {});
			if (!live.current) {
				return;
			}
			if (!answer.ok) {
				// A `refused` needs nothing here: `Session.call` has already fired `onRefusal`, and
				// the router is coming down. Saying "unreachable" over it would be the panel's last
				// word being the wrong one.
				if (answer.refusal === 'unanswered') {
					setState({ status: 'unreachable' });
				}
				return;
			}
			// An `error` envelope and a result this panel cannot parse are folded in with
			// `unanswered` on purpose, and only here — `host-client.ts` keeps the two vocabularies
			// apart because one is about the credential and the connection while the other is a
			// value. What this screen has to decide is narrower: nothing usable came back, and §7's
			// headline "must not claim to know which" covers a daemon answering something this
			// panel cannot read just as it covers one that answered nothing.
			const parsed =
				answer.value.type === 'result'
					? ListDevicesResultSchema.safeParse(answer.value.result)
					: undefined;
			if (parsed === undefined || !parsed.success) {
				setState({ status: 'unreachable' });
				return;
			}
			setState({
				status: 'ready',
				devices: parsed.data.devices,
				stale: parsed.data.stale,
				receivedAtMs: Date.now(),
			});
		} finally {
			asking.current = false;
		}
	}, [call]);

	useEffect(() => {
		live.current = true;
		void read();
		const ticking = setInterval(() => void read(), POLL_MS);
		return () => {
			live.current = false;
			clearInterval(ticking);
		};
	}, [read]);

	const refresh = useCallback((): void => {
		void read();
	}, [read]);

	return (
		<DeviceListContext.Provider value={{ state, refresh }}>{children}</DeviceListContext.Provider>
	);
}

export function useDeviceList(): DeviceList {
	const list = useContext(DeviceListContext);
	if (list === undefined) {
		throw new Error('useDeviceList was called outside a DeviceListProvider');
	}
	return list;
}

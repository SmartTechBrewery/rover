/**
 * The TypeScript face of `./idb-companion-locations.mjs`.
 *
 * That module is JavaScript because `scripts/check-idb.mjs` has to import it under plain `node`
 * at `npm install` time — see its header for why the order lives in one file rather than two.
 * This is the declaration `./idb-companion-path.ts` reads; the two are kept in step by the import
 * there, which stops compiling the moment an export is renamed away.
 */

/**
 * One place the search consults, and the file it named — or `null` when it named nothing.
 *
 * `path` is already the executable, not a directory holding it. `absent` is what to show in place
 * of a path when the place named nothing.
 */
export interface IdbCompanionSearchLocation {
	readonly source: string;
	readonly path: string | null;
	readonly absent?: string;
}

/** The program, named the way an operator would name it. */
export declare const IDB_COMPANION: string;

/** The one setting that overrides the whole search. */
export declare const IDB_COMPANION_PATH_ENV_VAR: string;

/** The release Rover installs, pinned. */
export declare const IDB_COMPANION_VERSION: string;

/** The one asset that release publishes for this platform. */
export declare const IDB_COMPANION_ASSET: string;

/** The architecture that asset runs on. */
export declare const IDB_COMPANION_ARCH: string;

export declare function idbCompanionReleaseUrl(version?: string): string;

export declare function idbCompanionChecksumUrl(version?: string): string;

export declare function managedIdbCompanionDirectory(home?: string, version?: string): string;

export declare function managedIdbCompanion(home?: string, version?: string): string;

export declare function idbCompanionSearchLocations(
	env?: NodeJS.ProcessEnv,
	platform?: NodeJS.Platform,
	home?: string,
): IdbCompanionSearchLocation[];

export declare function findIdbCompanion(
	env?: NodeJS.ProcessEnv,
	platform?: NodeJS.Platform,
	home?: string,
): string | null;

/**
 * The TypeScript face of `./adb-locations.mjs`.
 *
 * That module is JavaScript because `scripts/check-adb.mjs` has to import it under plain `node`
 * at `npm install` time — see its header for why the order lives in one file rather than two.
 * This is the declaration `./adb-path.ts` reads; the two are kept in step by the import there,
 * which stops compiling the moment an export is renamed away.
 */

/**
 * One place the search looks, whether or not it yielded anything.
 *
 * `paths` are the candidate files, in order. `shown` is what a failure message lists, and it
 * differs for `PATH` alone: the directories searched rather than one `…/adb` per executable name.
 */
export interface AdbSearchLocation {
	readonly source: string;
	readonly shown: readonly string[];
	readonly paths: readonly string[];
}

/** One candidate file, with the place that contributed it. */
export interface AdbCandidate {
	readonly source: string;
	readonly path: string;
}

/** The program every verb of this backend goes through. */
export declare const ADB: string;

/** The one setting that overrides the whole search. */
export declare const ADB_PATH_ENV_VAR: string;

export declare function executableNames(
	platform?: NodeJS.Platform,
	env?: NodeJS.ProcessEnv,
): string[];

export declare function isExecutableFile(candidate: string, platform?: NodeJS.Platform): boolean;

export declare function adbSearchLocations(
	env?: NodeJS.ProcessEnv,
	platform?: NodeJS.Platform,
	home?: string,
): AdbSearchLocation[];

export declare function adbCandidates(
	env?: NodeJS.ProcessEnv,
	platform?: NodeJS.Platform,
	home?: string,
): AdbCandidate[];

export declare function findAdb(
	env?: NodeJS.ProcessEnv,
	platform?: NodeJS.Platform,
	home?: string,
): AdbCandidate | null;

export declare function describeAdbSearch(locations: readonly AdbSearchLocation[]): string[];

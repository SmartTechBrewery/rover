/**
 * The three exit codes every command answers with.
 *
 * Their own module rather than `../index.ts`, so a shared helper that picks one
 * (`./verb.ts`'s `exitCodeFor`) can name it without importing the dispatcher that imports
 * the command that imports the helper. `../index.ts` re-exports all three, so a caller
 * outside `src/cli/` still reads them off the entrypoint.
 */

/** Success. */
export const EXIT_OK = 0;
/** The operation did not succeed — see the dispatcher's usage text for what counts. */
export const EXIT_FAILED = 1;
/** The caller asked wrong. Always paired with the usage text. */
export const EXIT_USAGE = 2;

/**
 * Single canonical registration entrypoint for every device backend.
 *
 * Every runtime surface that needs backends registered imports this file as a
 * side-effect module; each import below triggers that backend's module-load
 * registration into the device backend registry. Adding a backend is **one import line
 * here** plus its own folder — never an edit to dispatch code (ai/RULES.md §2,
 * ai/CODING_STANDARDS.md "Module shape for a device backend"). Mirrors Swarm's
 * `src/integrations/entrypoint.ts` (D15).
 *
 * **There are deliberately no imports yet.** The device contract, the capability
 * manifest and the registry ship before any backend does, so the shape is settled before
 * the first implementation is written against it.
 *
 * This file deliberately does **not** re-export the registry surface: a caller that
 * wants only a lookup must not pull every backend into its module graph. Import
 * `./registry.js` directly for that.
 */

/**
 * Explicit no-op for call sites that want registration to be visible rather than relying
 * on the bare import side effect. In production, importing this module is already
 * enough — the imports above have done the work by the time this is callable.
 */
export function registerAllBackends(): void {
	// Intentionally empty — see the module doc comment.
}

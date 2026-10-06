/**
 * What `rover init` can read out of an Xcode project or workspace without running Xcode: which
 * shared schemes build an application, through which container, in which configuration.
 *
 * It is the same kind of read `./detect.ts` does of a Gradle build file — static, bounded, and
 * answering nothing rather than a plausible default — and it stays inside the platform-name gate
 * for the reason that file does: it recognises a build system, it is not a backend. The line it
 * leads to is `./install-lines.ts`'s.
 *
 * **Only shared schemes are read.** A shared scheme is the one under `xcshareddata/`, which is the
 * one a checkout carries; a scheme that is not shared lives in somebody's own `xcuserdata/`, and a
 * scheme Xcode would create on the fly from the project's targets exists nowhere on disk at all.
 * Proposing either would be proposing a build that works on one machine, or on none, so a
 * container with no shared application scheme is reported as such and the operator is told how to
 * share one.
 *
 * **A project a workspace names is built through that workspace**, and is not offered again on
 * its own: a workspace is how a dependency manager wires its own projects in, and building the
 * application's project bare leaves those out and fails.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, normalize } from 'node:path';
import type { XcodeBuild } from './install-lines.js';

/** One shared scheme that builds an application, and the scheme file it was read from. */
export interface XcodeScheme extends XcodeBuild {
	/** The project-relative path of the `.xcscheme` file. */
	readonly source: string;
}

/** Every Xcode container init found, and the application schemes among their shared schemes. */
export interface XcodeFindings {
	/** Project-relative workspace and project paths, workspaces first. */
	readonly containers: readonly string[];
	readonly schemes: readonly XcodeScheme[];
}

const WORKSPACE = '.xcworkspace';
const PROJECT = '.xcodeproj';

/**
 * Directories never looked inside: dependency checkouts and build output, whose projects are
 * somebody else's, and every dot-directory.
 */
const NOT_SEARCHED = new Set(['node_modules', 'Pods', 'Carthage', 'build', 'DerivedData']);

/**
 * The application a scheme's Run action launches, and the configuration it builds it in — or
 * `undefined` when the scheme runs no application.
 *
 * That is a `LaunchAction` holding a `BuildableProductRunnable` whose `BuildableName` ends in
 * exactly `.app`: an extension (`.appex`), a framework, a test-only scheme with nothing to run,
 * and every scheme of a dependency manager's own project all fall out here. The configuration is
 * the Run action's own rather than an assumed `Debug`, because the directory the product lands in
 * is named after it.
 *
 * Exported for its own unit tests: it is pure.
 */
export function appSchemeIn(
	xml: string,
): { readonly product: string; readonly configuration: string } | undefined {
	const launch = /<LaunchAction\b([^>]*)>([\s\S]*?)<\/LaunchAction>/.exec(xml);
	if (launch === null) {
		return undefined;
	}
	const configuration = attribute(launch[1] ?? '', 'buildConfiguration');
	const runnable = /<BuildableProductRunnable\b[^>]*>([\s\S]*?)<\/BuildableProductRunnable>/.exec(
		launch[2] ?? '',
	);
	const reference = /<BuildableReference\b([^>]*)>/.exec(runnable?.[1] ?? '');
	const product = attribute(reference?.[1] ?? '', 'BuildableName');
	if (configuration === undefined || configuration === '' || product === undefined) {
		return undefined;
	}
	return product.endsWith('.app') && product.length > '.app'.length
		? { product, configuration }
		: undefined;
}

/**
 * The project paths a workspace's `contents.xcworkspacedata` names, as written — relative to the
 * directory the workspace sits in.
 *
 * `group:` and `container:` both resolve from there for a reference at the workspace's top level,
 * which is where Xcode and every dependency manager put a project. `self:` is the workspace every
 * project carries inside itself, and a reference to anything but a project is not a build.
 *
 * Exported for its own unit tests: it is pure.
 */
export function workspaceProjectsIn(xml: string): string[] {
	const projects: string[] = [];
	for (const match of xml.matchAll(/<FileRef\b([^>]*)>/g)) {
		const location = attribute(match[1] ?? '', 'location');
		const path = /^(?:group|container):(.+)$/.exec(location ?? '')?.[1];
		if (path?.endsWith(PROJECT) && !projects.includes(path)) {
			projects.push(path);
		}
	}
	return projects;
}

/**
 * The Xcode containers in a project and the application schemes they share, or `undefined` when
 * there is no container at all.
 *
 * It looks in the project's root and its **immediate** subdirectories, which is where the
 * cross-platform layouts keep theirs (a `Runner.xcworkspace` one folder down, say) —
 * deeper than that is guessing — and never inside a container bundle, which also passes over
 * the workspace every project carries inside itself.
 */
export async function findXcodeAppSchemes(directory: string): Promise<XcodeFindings | undefined> {
	const { workspaces, projects } = await containersIn(directory);
	if (workspaces.length === 0 && projects.length === 0) {
		return undefined;
	}

	const schemes: XcodeScheme[] = [];
	const builtThroughAWorkspace = new Set<string>();
	for (const workspace of workspaces) {
		const referenced = await referencedProjects(directory, workspace);
		for (const project of referenced) {
			builtThroughAWorkspace.add(project);
		}
		for (const container of [workspace, ...referenced]) {
			schemes.push(...(await sharedAppSchemes(directory, container, workspace, 'workspace')));
		}
	}
	for (const project of projects) {
		if (!builtThroughAWorkspace.has(project)) {
			schemes.push(...(await sharedAppSchemes(directory, project, project, 'project')));
		}
	}
	return { containers: [...workspaces, ...projects], schemes: oncePerBuild(schemes) };
}

/** The workspaces and projects in the root and its searched subdirectories, root-relative. */
async function containersIn(
	directory: string,
): Promise<{ readonly workspaces: string[]; readonly projects: string[] }> {
	const workspaces: string[] = [];
	const projects: string[] = [];
	for (const folder of ['', ...(await searchedSubdirectories(directory))]) {
		for (const entry of await directoriesIn(join(directory, folder))) {
			if (entry.endsWith(WORKSPACE)) {
				workspaces.push(join(folder, entry));
			} else if (entry.endsWith(PROJECT)) {
				projects.push(join(folder, entry));
			}
		}
	}
	return { workspaces, projects };
}

/** The projects a workspace names that are really there, root-relative. */
async function referencedProjects(root: string, workspace: string): Promise<string[]> {
	const data = await readIfPresent(join(root, workspace, 'contents.xcworkspacedata'));
	const referenced: string[] = [];
	for (const named of workspaceProjectsIn(data ?? '')) {
		const project = normalize(join(dirname(workspace), named));
		if ((await directoriesIn(join(root, dirname(project)))).includes(basename(project))) {
			referenced.push(project);
		}
	}
	return referenced;
}

/** The application schemes `container` shares, each built through `buildThrough`. */
async function sharedAppSchemes(
	root: string,
	container: string,
	buildThrough: string,
	kind: XcodeBuild['kind'],
): Promise<XcodeScheme[]> {
	const folder = join(container, 'xcshareddata', 'xcschemes');
	let names: string[];
	try {
		names = (await readdir(join(root, folder))).filter((name) => name.endsWith('.xcscheme'));
	} catch {
		return [];
	}
	const found: XcodeScheme[] = [];
	for (const name of names.sort()) {
		const source = join(folder, name);
		const app = appSchemeIn((await readIfPresent(join(root, source))) ?? '');
		if (app !== undefined) {
			found.push({
				container: buildThrough,
				kind,
				scheme: name.slice(0, -'.xcscheme'.length),
				...app,
				source,
			});
		}
	}
	return found;
}

/** A scheme a workspace and its own project both share is one build, offered once. */
function oncePerBuild(schemes: readonly XcodeScheme[]): XcodeScheme[] {
	const seen = new Set<string>();
	return schemes.filter((scheme) => {
		const key = `${scheme.container}\n${scheme.scheme}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** The project's own immediate subdirectories worth looking in, sorted. */
async function searchedSubdirectories(directory: string): Promise<string[]> {
	return (await directoriesIn(directory)).filter(
		(name) =>
			!name.startsWith('.') &&
			!NOT_SEARCHED.has(name) &&
			!name.endsWith(WORKSPACE) &&
			!name.endsWith(PROJECT),
	);
}

/** The names of the directories directly inside `directory`, sorted; none when it is unreadable. */
async function directoriesIn(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

/** One attribute's value out of a tag's attribute text — Xcode writes `Name = "value"`. */
function attribute(attributes: string, name: string): string | undefined {
	const value = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attributes)?.[1];
	return value === undefined ? undefined : decodeEntities(value);
}

/** The five entities XML escapes, decoded — `&amp;` last, so `&amp;lt;` stays `&lt;`. */
function decodeEntities(value: string): string {
	return value
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&apos;', "'")
		.replaceAll('&amp;', '&');
}

async function readIfPresent(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch {
		return undefined;
	}
}

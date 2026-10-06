/**
 * The shell lines `rover init` proposes as a project's `install` hook — the text it writes into a
 * host's hook file, and nothing else.
 *
 * **This file is exempt from `tests/unit/no-platform-names.test.ts`, for the reason
 * `./documents.ts` is.** A proposed install *is* a call to the platform's own build and install
 * tools, and pinning that call to the leased device is the whole of what makes it correct, so the
 * line cannot be written without naming them. All the reading that decides *which* line to
 * propose lives in `./detect.ts` and `./xcode.ts`, which stay inside the gate.
 */

/**
 * The install a Gradle project gets proposed, for one build variant.
 *
 * Three things in the line are load-bearing. `bash` is the program because the line needs a shell
 * to expand a variable and hooks are never word-split (`src/daemon/project-hooks.ts`) — an
 * operator who wants a shell makes the shell the program. The environment variable is what
 * carries the lease's device into the build's own install step, out of the `ROVER_DEVICE_SERIAL`
 * the host sets on every hook child: **without it the install task installs onto every attached
 * device**, which on a shared host is every neighbour's lease as well as this one's. And `-q`,
 * because the hook's stdout is a build log nobody reads unless it failed, and a failure reports
 * its own stderr tail.
 *
 * The task's own name is the variant's, capitalised. A variant is its flavors in declared
 * dimension order followed by the build type — `dev` and `free` under dimensions `env, tier`
 * give `devFreeDebug`, whose task is `:app:installDevFreeDebug`. A project with no flavors has
 * the plain `debug` variant and so the `:app:installDebug` this used to be a constant for.
 */
export function gradleInstall(variant: string): string {
	return `ANDROID_SERIAL="$ROVER_DEVICE_SERIAL" ./gradlew :app:install${upperFirst(variant)} -q`;
}

/** One Xcode scheme that builds an application, and the container it is built through. */
export interface XcodeBuild {
	/** The workspace or project, relative to the project root. */
	readonly container: string;
	readonly kind: 'workspace' | 'project';
	readonly scheme: string;
	/** The build configuration the scheme's own Run action uses — read, never assumed. */
	readonly configuration: string;
	/** The bundle the scheme's Run action launches, `App.app`. */
	readonly product: string;
}

/**
 * The install an Xcode project gets proposed, for one shared scheme that builds an application.
 *
 * It builds for the leased simulator and installs onto that simulator only (#306), and every part
 * of the line is there for a reason `docs/MANUAL.md` ("An Xcode install, and why it names the
 * simulator") spells out:
 *
 * - **`-destination "id=$ROVER_DEVICE_SERIAL"` and `simctl install "$ROVER_DEVICE_SERIAL"`.** On
 *   the simulator backend a device's serial is its UDID. `booted` in its place means whichever
 *   booted simulator the tool picks, and on a shared host that is a neighbour's lease.
 * - **Derived data per `ROVER_PROJECT` and `ROVER_SLOT`, outside the checkout.** Two leases on one
 *   project can install at once and two builds on one derived-data directory contend for its
 *   build database; a slot is never held by two live leases and is reused, so an incremental
 *   build survives from one lease to the next. Under Xcode's own `DerivedData` it stays out of the
 *   project's tree, in the place Xcode users already treat as a disposable cache.
 * - **`-configuration`**, the scheme's own, so the products directory is the one this line names:
 *   `<configuration>-iphonesimulator`.
 * - **`-quiet build >&2`.** A hook's stdout is drained and dropped and only its stderr tail reaches
 *   `install-hook-failed`, so the compiler's errors are sent where the agent will read them.
 */
export function xcodeInstall(build: XcodeBuild): string {
	const derivedData =
		'"$HOME/Library/Developer/Xcode/DerivedData/rover-$ROVER_PROJECT-$ROVER_SLOT"';
	const products = `"$d/Build/Products/${inDoubleQuotes(build.configuration)}-iphonesimulator/${inDoubleQuotes(build.product)}"`;
	return [
		`d=${derivedData}`,
		[
			'xcodebuild',
			`-${build.kind}`,
			shellWord(build.container),
			'-scheme',
			shellWord(build.scheme),
			'-configuration',
			shellWord(build.configuration),
			'-destination "id=$ROVER_DEVICE_SERIAL"',
			'-derivedDataPath "$d"',
			'-quiet build >&2',
		].join(' '),
		`xcrun simctl install "$ROVER_DEVICE_SERIAL" ${products}`,
	].join(' && ');
}

/**
 * A value as one shell word: bare when it is plainly safe, single-quoted otherwise.
 *
 * Containers, schemes and products are names somebody chose and may carry a space or a quote.
 */
function shellWord(value: string): string {
	return /^[A-Za-z0-9._/@%+=:,-]+$/.test(value)
		? value
		: `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

/**
 * A name as it has to be written inside a double-quoted shell word, which this line needs so `$d`
 * still expands: `$`, a backtick, a backslash and the quote itself are escaped, and nothing else.
 */
function inDoubleQuotes(value: string): string {
	return value.replaceAll(/[$`"\\]/g, '\\$&');
}

export function upperFirst(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

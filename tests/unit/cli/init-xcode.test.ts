/**
 * The static read of Xcode schemes and workspaces, and the install line `rover init` proposes from
 * it (#306).
 *
 * The rule is `src/cli/init/detect.ts`'s — **a wrong install is worse than no install** — so the
 * negative cases matter as much as the positive ones: a framework, an extension or a test-only
 * scheme proposed as an install is a build that "worked" and put nothing runnable on the device.
 * The line itself is asserted for the one property that keeps it off a neighbour's simulator: it
 * names the leased one by its serial, and never `booted`.
 *
 * Names here are deliberately generic (`App`, `Runner`). Real projects' names are their own, and
 * `ai/RULES.md` §7 is about keeping them out of this repository.
 */

import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { xcodeInstall } from '@/cli/init/install-lines.js';
import { appSchemeIn, workspaceProjectsIn } from '@/cli/init/xcode.js';

/** A shared scheme as Xcode writes one, with the Run action's runnable and configuration given. */
function scheme(launch: string): string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "1600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES">
   </BuildAction>
${launch}
</Scheme>
`;
}

function runnable(buildableName: string): string {
	return `      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         <BuildableReference
            BuildableIdentifier = "primary"
            BlueprintIdentifier = "0123456789ABCDEF"
            BuildableName = "${buildableName}"
            BlueprintName = "App"
            ReferencedContainer = "container:App.xcodeproj">
         </BuildableReference>
      </BuildableProductRunnable>`;
}

function launchAction(configuration: string, body: string): string {
	return `   <LaunchAction
      buildConfiguration = "${configuration}"
      launchStyle = "0">
${body}
   </LaunchAction>`;
}

describe('appSchemeIn', () => {
	it('reads the application and the configuration a scheme runs', () => {
		expect(appSchemeIn(scheme(launchAction('Debug', runnable('App.app'))))).toEqual({
			product: 'App.app',
			configuration: 'Debug',
		});
	});

	it('reads a custom configuration rather than assuming Debug', () => {
		expect(appSchemeIn(scheme(launchAction('Staging Debug', runnable('App.app'))))).toEqual({
			product: 'App.app',
			configuration: 'Staging Debug',
		});
	});

	it('decodes the entities Xcode escapes a name with', () => {
		expect(appSchemeIn(scheme(launchAction('Debug', runnable('Tom &amp; Jerry.app'))))).toEqual({
			product: 'Tom & Jerry.app',
			configuration: 'Debug',
		});
	});

	it('reads attributes written without the spaces Xcode puts around =', () => {
		const xml =
			'<Scheme><LaunchAction buildConfiguration="Debug"><BuildableProductRunnable>' +
			'<BuildableReference BuildableName="App.app"></BuildableReference>' +
			'</BuildableProductRunnable></LaunchAction></Scheme>';

		expect(appSchemeIn(xml)).toEqual({ product: 'App.app', configuration: 'Debug' });
	});

	it('is nothing for a scheme that builds a framework or an extension', () => {
		expect(appSchemeIn(scheme(launchAction('Debug', runnable('Kit.framework'))))).toBeUndefined();
		expect(appSchemeIn(scheme(launchAction('Debug', runnable('Widget.appex'))))).toBeUndefined();
	});

	it('is nothing for a test-only scheme, which runs no application', () => {
		expect(appSchemeIn(scheme(launchAction('Debug', '')))).toBeUndefined();
		expect(appSchemeIn(scheme(''))).toBeUndefined();
	});

	it('is nothing when the Run action names no configuration', () => {
		const xml = scheme(`   <LaunchAction>\n${runnable('App.app')}\n   </LaunchAction>`);

		expect(appSchemeIn(xml)).toBeUndefined();
	});
});

describe('workspaceProjectsIn', () => {
	it('reads group: and container: references to projects, and nothing else', () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Workspace
   version = "1.0">
   <FileRef
      location = "group:App.xcodeproj">
   </FileRef>
   <FileRef
      location = "container:Pods/Pods.xcodeproj">
   </FileRef>
   <FileRef
      location = "self:">
   </FileRef>
   <FileRef
      location = "group:README.md">
   </FileRef>
</Workspace>
`;

		expect(workspaceProjectsIn(xml)).toEqual(['App.xcodeproj', 'Pods/Pods.xcodeproj']);
	});
});

describe('xcodeInstall', () => {
	const build = {
		container: 'ios/Runner.xcworkspace',
		kind: 'workspace',
		scheme: 'Runner',
		configuration: 'Debug',
		product: 'Runner.app',
	} as const;

	it('builds through the workspace for the leased simulator and installs onto it', () => {
		expect(xcodeInstall(build)).toBe(
			'd="$HOME/Library/Developer/Xcode/DerivedData/rover-$ROVER_PROJECT-$ROVER_SLOT" && ' +
				'xcodebuild -workspace ios/Runner.xcworkspace -scheme Runner -configuration Debug ' +
				'-destination "id=$ROVER_DEVICE_SERIAL" -derivedDataPath "$d" -quiet build >&2 && ' +
				'xcrun simctl install "$ROVER_DEVICE_SERIAL" ' +
				'"$d/Build/Products/Debug-iphonesimulator/Runner.app"',
		);
	});

	it('builds a bare project with -project', () => {
		expect(xcodeInstall({ ...build, container: 'App.xcodeproj', kind: 'project' })).toContain(
			'xcodebuild -project App.xcodeproj -scheme Runner ',
		);
	});

	// `booted` is whichever booted simulator the tool picks — on a shared host, a neighbour's.
	it('never names booted', () => {
		expect(xcodeInstall(build)).not.toContain('booted');
	});

	it('quotes names with spaces and quotes in them, and stays one valid shell line', () => {
		const line = xcodeInstall({
			container: "My App's.xcodeproj",
			kind: 'project',
			scheme: 'My App',
			configuration: 'Staging Debug',
			product: 'My "App".app',
		});

		expect(line).toContain(String.raw`-project 'My App'\''s.xcodeproj' -scheme 'My App'`);
		expect(line).toContain(
			String.raw`"$d/Build/Products/Staging Debug-iphonesimulator/My \"App\".app"`,
		);
		// `-n` parses without running anything, so nothing here reaches Xcode.
		expect(() => execFileSync('bash', ['-n', '-c', line])).not.toThrow();
	});
});

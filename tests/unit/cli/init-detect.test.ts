/**
 * The static read of a Gradle app build file, which is the whole of what `rover init` knows about
 * product flavors.
 *
 * Every case here is about the same rule from `src/cli/init/detect.ts`: **a wrong install is
 * worse than no install.** A flavored project has no `:app:installDebug` at all, so the three
 * answers this parse can give — the plain debug variant, the variants it read, and "I could not
 * read this" — are each a different way of refusing to invent a task name. The negative cases
 * matter more than the positive ones, because the failure they prevent is silent: an install hook
 * naming a task Gradle does not have fails at the agent's first `install_app`, days later, in
 * somebody else's repository.
 *
 * Flavor names here are deliberately generic (`free`/`paid`, `dev`/`prod`). Real projects' names
 * are their own, and `ai/RULES.md` §7 is about keeping them out of this repository.
 */

import { describe, expect, it } from 'vitest';
import { gradleDebugVariants } from '@/cli/init/detect.js';

describe('gradleDebugVariants', () => {
	it('answers undefined for a build file that declares no flavors at all', () => {
		const file = 'plugins { id("com.example.app") }\nandroid {\n  namespace = "com.example"\n}\n';

		// Not an empty list: "no flavors" and "flavors I could not read" are different answers,
		// and only the first one keeps the plain debug variant.
		expect(gradleDebugVariants(file)).toBeUndefined();
	});

	it('reads Groovy flavors declared as bare blocks', () => {
		const file = `android {
  flavorDimensions "tier"
  productFlavors {
    free { dimension "tier" }
    paid { dimension "tier" }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual(['freeDebug', 'paidDebug']);
	});

	it('reads flavors declared through the container, as a real Groovy project does', () => {
		const file = `android {
  flavorDimensions "tier"
  productFlavors {
    create("free") {
      dimension "tier"
    }
    create("paid") {
      dimension "tier"
    }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual(['freeDebug', 'paidDebug']);
	});

	it('composes two dimensions in the order they were declared, not the order flavors appear', () => {
		const file = `android {
  flavorDimensions += listOf("env", "tier")
  productFlavors {
    create("free") { dimension = "tier" }
    create("paid") { dimension = "tier" }
    create("dev") { dimension = "env" }
    create("prod") { dimension = "env" }
  }
}
`;

		// The flavors are written tier-first and the variants still come out env-first: the
		// declaration is what names a variant, which is the one rule a hand-written guess gets wrong.
		expect(gradleDebugVariants(file)).toEqual([
			'devFreeDebug',
			'devPaidDebug',
			'prodFreeDebug',
			'prodPaidDebug',
		]);
	});

	it('reads a dimension list that spans several lines', () => {
		const file = `android {
  flavorDimensions += listOf(
    "env",
    "tier",
  )
  productFlavors {
    create("dev") { dimension = "env" }
    create("free") { dimension = "tier" }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual(['devFreeDebug']);
	});

	it('proposes the one variant a single-flavor project has', () => {
		const file = `android {
  productFlavors {
    create("free") { dimension = "tier" }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual(['freeDebug']);
	});

	it('ignores a flavor inside a comment, and is not confused by a url in a string', () => {
		const file = `android {
  // productFlavors { create("ghost") { dimension = "tier" } }
  /* create("spectre") */
  defaultConfig {
    buildConfigField("String", "API", "\\"https://example.test/{id}\\"")
  }
  productFlavors {
    create("free") { dimension = "tier" }
    create("paid") { dimension = "tier" }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual(['freeDebug', 'paidDebug']);
	});

	it('resolves nothing for flavors built in a loop', () => {
		const file = `android {
  flavorDimensions += "tier"
  productFlavors {
    for (tier in tiers) {
      create(tier.name) { dimension = "tier" }
    }
  }
}
`;

		// Empty, not undefined: the project has flavors, so it has no ':app:installDebug' either,
		// and proposing one would be the guess the module exists to avoid.
		expect(gradleDebugVariants(file)).toEqual([]);
	});

	it('resolves nothing for an all { } block, whose names are not in the file', () => {
		const file = `android {
  productFlavors {
    all {
      dimension = "tier"
    }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual([]);
	});

	it('resolves nothing when a statement in the block is not a flavor declaration', () => {
		const file = `android {
  productFlavors {
    val names = listOf("free", "paid")
    create("free") { dimension = "tier" }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual([]);
	});

	it('resolves nothing when a flavor names a dimension nothing declared', () => {
		const file = `android {
  flavorDimensions += listOf("env", "tier")
  productFlavors {
    create("dev") { dimension = "env" }
    create("free") { dimension = "tier" }
    create("extra") { dimension = "unknown" }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual([]);
	});

	it('resolves nothing when a declared dimension has no flavor filling it', () => {
		const file = `android {
  flavorDimensions += listOf("env", "tier")
  productFlavors {
    create("free") { dimension = "tier" }
    create("paid") { dimension = "tier" }
  }
}
`;

		expect(gradleDebugVariants(file)).toEqual([]);
	});

	it('resolves nothing when the word appears with no block behind it', () => {
		const file =
			'android {\n  // see productFlavors in the parent build\n}\nval productFlavors = 1\n';

		expect(gradleDebugVariants(file)).toEqual([]);
	});
});

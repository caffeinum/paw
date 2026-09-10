// Stamp the ABSOLUTE path of this paw checkout into the build output.
//
// `cotal ext add ./plugin` COPIES this package into cotal's extension prefix (npm runs with
// `--install-links`, so a path spec is packed, never symlinked). Once copied, nothing relative
// leads back to the repo — and the repo is exactly what has to run: src/lifecycle.ts pins
// `REPO_ROOT` to the checkout and drives the mesh/manager/beacon daemons through `<root>/bin/*.ts`
// under `<root>/node_modules/tsx`. So the path is recorded at build time and read at run time.
//
// Machine-specific by construction: dist/ is gitignored, and the stamp is rewritten by every build.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

if (!existsSync(join(root, "bin", "paw.ts"))) {
  throw new Error(`stamp-root: ${root} does not look like a paw checkout (no bin/paw.ts)`);
}

const out = join(here, "..", "dist");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "paw-root.json"), `${JSON.stringify({ root }, null, 2)}\n`);
console.log(`stamped paw root: ${root}`);

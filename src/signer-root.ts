/**
 * A remote space's signer root check, shared by `paw mesh add` and `paw doctor`. A LEAF (no registry
 * import), so doctor can validate a record without registering `paw mesh`.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { authDir, loadSpaceAuth } from "@cotal-ai/workspace";

/** The signer under `root` must load for `space` and be readable by you alone. Never echoes it. */
export function checkSignerRoot(space: string, rootArg: string): string {
  const root = resolve(rootArg);
  let st;
  try {
    st = statSync(root);
  } catch {
    throw new Error(`paw: --root ${root} does not exist`);
  }
  if (!st.isDirectory()) throw new Error(`paw: --root ${root} is not a directory`);
  const dir = authDir(root);
  const auth = loadSpaceAuth(dir, space);
  if (!auth)
    throw new Error(
      `paw: no signer for space "${space}" under ${dir} — on the broker's box run \`cotal auth signer --out signer.json\` (\`cotal mint --signer --out signer.json\` before cotal 0.100), ` +
        `copy it to ${join(dir, "auth.json")} (chmod 600)`,
    );
  if (!auth.account?.signingSeed) throw new Error(`paw: the auth under ${dir} for "${space}" carries no account signing seed — it cannot mint agent creds`);
  for (const f of [join(dir, "auth.json")]) {
    let mode: number;
    try {
      mode = statSync(f).mode;
    } catch {
      continue; // split-layout roots carry account.<hex>.json instead; loadSpaceAuth already proved them
    }
    if (mode & 0o077) throw new Error(`paw: ${f} is readable by other users (mode ${(mode & 0o777).toString(8)}) — it is a bearer secret: chmod 600 ${f}`);
  }
  return root;
}

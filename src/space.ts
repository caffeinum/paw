/** The paw space a command acts on: `PAW_SPACE`, else the machine-wide default. Zero-dep leaf so
 *  modules lifecycle.ts imports (release.ts) can use it without an import cycle. */
const DEFAULT_SPACE = "paw";

export function resolveSpace(): string {
  const override = process.env.PAW_SPACE?.trim();
  return override && override.length > 0 ? override : DEFAULT_SPACE;
}

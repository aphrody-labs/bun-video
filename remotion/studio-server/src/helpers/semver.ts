// The subset of the `semver` package the Studio server uses, backed by Bun.semver.
const strict =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const valid = (version: string | null | undefined): string | null => {
  if (typeof version !== "string" || version.length > 256) return null;
  const cleaned = version.trim().replace(/^[=v]+/, "");
  return strict.test(cleaned) ? cleaned.replace(/\+.*$/, "") : null;
};

const order = (a: string, b: string) => Bun.semver.order(a, b);

export const semver = {
  valid,
  lt: (a: string, b: string) => order(a, b) < 0,
  gt: (a: string, b: string) => order(a, b) > 0,
  lte: (a: string, b: string) => order(a, b) <= 0,
  rcompare: (a: string, b: string) => order(b, a),
};

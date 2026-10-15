/** Lightweight semver compare (major.minor.patch[+prerelease ignored for equality floor]). */

function parse(v: string): [number, number, number] {
  const cleaned = String(v || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split("+")[0];
  const parts = cleaned.split(".").map((p) => Number.parseInt(p, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** Negative if a < b, 0 if equal, positive if a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function isBelow(current: string, floor: string): boolean {
  return compareSemver(current, floor) < 0;
}

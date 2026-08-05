/**
 * Fast object-tree size estimator — walks without JSON.stringify.
 * Safe for circular references (uses WeakSet).
 * Early-exits once `bytes` crosses `earlyExitAt` (default 256KB) to avoid
 * wasting CPU on huge payloads — the caller only needs "is this over my
 * threshold", not an exact total for values that are already way over it.
 * Pass the actual threshold you're comparing against (see
 * chatCore/logTruncation.ts::truncateForLog) so raising that threshold
 * doesn't silently cap what this function is even capable of reporting.
 */
export function estimateSizeFast(value: unknown, earlyExitAt = 262144): number {
  let bytes = 0;
  const stack: unknown[] = [value];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || v === undefined) continue;
    if (typeof v === "string") {
      bytes += v.length;
      if (bytes > earlyExitAt) return bytes;
    } else if (typeof v === "number") bytes += 8;
    else if (typeof v === "boolean") bytes += 4;
    else if (typeof v === "object") {
      if (seen.has(v as object)) continue;
      seen.add(v as object);
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) stack.push(v[i]);
      } else {
        for (const key in v) {
          if (Object.prototype.hasOwnProperty.call(v, key))
            stack.push((v as Record<string, unknown>)[key]);
        }
      }
    }
  }
  return bytes;
}

export function isSmallEnoughForSemanticCache(value: unknown): boolean {
  return estimateSizeFast(value) <= 256 * 1024;
}

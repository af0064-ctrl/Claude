/**
 * Reorder Antigravity provider connections so ones with an already-known
 * Cloud Code `projectId` are tried first.
 *
 * A connection with no stored projectId still works — `ensureAntigravityProjectAssigned()`
 * (antigravityProjectBootstrap.ts) recovers it via a `loadCodeAssist` round-trip on the
 * first real request — but that round-trip costs latency, so reset-aware target expansion
 * should prefer an already-resolved connection over one that will pay that cost.
 *
 * Fail-open: this only reorders, it never drops a connection. #8894 added the import for
 * this module to quotaStrategies.ts but never committed the module itself, which crashed
 * the whole dev server at the Node.js instrumentation-hook boot step (module not found).
 */

function hasStoredProjectId(connection: Record<string, unknown>): boolean {
  const direct = connection.projectId;
  if (typeof direct === "string" && direct.trim().length > 0) return true;

  const providerSpecificData = connection.providerSpecificData;
  if (providerSpecificData && typeof providerSpecificData === "object") {
    const nested = (providerSpecificData as Record<string, unknown>).projectId;
    if (typeof nested === "string" && nested.trim().length > 0) return true;
  }
  return false;
}

export function preferAntigravityConnectionsWithStoredProject<T extends Record<string, unknown>>(
  connections: T[]
): T[] {
  const withProject: T[] = [];
  const withoutProject: T[] = [];
  for (const connection of connections) {
    (hasStoredProjectId(connection) ? withProject : withoutProject).push(connection);
  }
  return [...withProject, ...withoutProject];
}

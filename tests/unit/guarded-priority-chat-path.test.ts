import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerHooks, register } from "node:module";

// The release/v3.8.50 base is missing open-sse/services/antigravityProjectPersistence.ts
// (known baseline gap, unrelated to this feature). Stub ONLY that single module so the
// real chat request path can be loaded and exercised; every other module under test
// (chat.ts, combo.ts, quotaStrategies.ts, runtimeUnits.ts, the executor, the route)
// remains genuine production code.
const STUB_URL = "file:///omniroute-test/antigravity-project-persistence-stub.mjs";
const STUB_SOURCE = `export const preferAntigravityConnectionsWithStoredProject = async () => null;\n`;

// The same release base also carries a duplicate `134_*` migration pair
// (134_ccr_blocks + 134_proxy_logs_egress_ip), which makes the migration runner abort
// EVERY fresh SQLite database in this branch (known baseline gap, unrelated to this
// feature). This harness adds that pair to the superseded-duplicate table purely at
// load time, so the REAL migration runner applies every other migration and a fresh DB
// is fully usable. No repository file is modified.
const MIGRATION_CONSTANTS_URL = new URL(
  "../../src/lib/db/migrationRunner/constants.ts",
  import.meta.url
).href;
const stubHooks = {
  resolve(specifier: string, context: unknown, nextResolve: Function) {
    if (specifier.endsWith("antigravityProjectPersistence.ts")) {
      return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url: string, context: unknown, nextLoad: Function) {
    if (url === STUB_URL) {
      return { format: "module", source: STUB_SOURCE, shortCircuit: true };
    }
    if (url === MIGRATION_CONSTANTS_URL) {
      const realSource = fs.readFileSync(new URL(url), "utf8");
      const marker = 'supersededByName: "session_account_affinity",\n  },\n] as const;';
      const patch =
        'supersededByName: "session_account_affinity",\n  },\n  {\n    version: "134",\n    name: "proxy_logs_egress_ip",\n    supersededByVersion: "134",\n    supersededByName: "ccr_blocks",\n  },\n] as const;';
      if (!realSource.includes(marker)) {
        throw new Error("migration constants superseded table marker not found");
      }
      return {
        format: "module",
        source: realSource.replace(marker, patch).replace(/ as const;/g, ";"),
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
};
if (typeof registerHooks === "function") {
  (registerHooks as (hooks: unknown) => unknown)(stubHooks);
} else {
  register("file:///omniroute-test/antigravity-project-persistence-stub.mjs");
}

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-guarded-chat-path-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const settingsDb = await import("../../src/lib/db/settings.ts");
const combosDb = await import("../../src/lib/db/combos.ts");
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");
const { resetAllCircuitBreakers } = await import("../../src/shared/utils/circuitBreaker.ts");
const { clearNodeOfflineState } = await import("../../open-sse/services/combo/offlineState.ts");

const HARD_OFFLINE = { "omniroute.accountUnavailable": null };
const originalFetch = globalThis.fetch;

async function flushBackgroundWork() {
  await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setImmediate(resolve));
}

async function resetStorage() {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  resetAllCircuitBreakers();
  clearNodeOfflineState();
}

type SeededConnection = { id: string };

async function seedConnection(
  name: string,
  apiKey: string,
  extra: Record<string, unknown> = {}
): Promise<SeededConnection> {
  const created = await providersDb.createProviderConnection({
    provider: "openai",
    authType: "apikey",
    name,
    apiKey,
    isActive: true,
    testStatus: "active",
    ...extra,
  });
  return { id: String((created as { id?: unknown }).id ?? "") };
}

async function seedGuardedCombo(
  connAId: string,
  connBId: string | null,
  options: { name?: string; strategy?: string } = {}
) {
  const models: Record<string, unknown>[] = [
    {
      providerId: "openai",
      model: "gpt-4.1",
      connectionId: connAId,
      ...(options.strategy !== "priority"
        ? { offlineCondition: HARD_OFFLINE, offlineCooldownMs: 60_000 }
        : {}),
    },
  ];
  if (connBId) {
    models.push({
      providerId: "openai",
      model: "gpt-4.1",
      connectionId: connBId,
      ...(options.strategy !== "priority"
        ? { offlineCondition: HARD_OFFLINE, offlineCooldownMs: 60_000 }
        : {}),
    });
  }
  return combosDb.createCombo({
    name: options.name ?? "guarded-combo",
    strategy: options.strategy ?? "guarded-priority",
    models,
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });
}

function makeRequest(model = "guarded-combo") {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Bypass the semantic cache so each scenario observes the real upstream dispatch.
      "X-OmniRoute-No-Cache": "true",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with OK only." }],
      max_tokens: 16,
      stream: false,
      temperature: 0,
    }),
  });
}

function upstream(status: number, payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function authorization(init: Record<string, unknown> | undefined): string {
  const headers = (init?.headers ?? {}) as Record<string, unknown>;
  return String(headers.Authorization ?? headers.authorization ?? "");
}

const OK_FROM_B = {
  id: "chatcmpl-guarded-b",
  choices: [{ message: { role: "assistant", content: "FROM-B" } }],
};

test.beforeEach(async () => {
  globalThis.fetch = originalFetch;
  await resetStorage();
});

test.afterEach(async () => {
  await flushBackgroundWork();
  globalThis.fetch = originalFetch;
  resetAllCircuitBreakers();
});

test.after(async () => {
  await flushBackgroundWork();
  globalThis.fetch = originalFetch;
  resetAllCircuitBreakers();
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("guarded-priority actual path: non-matching 502 from selected account returns unchanged and never calls the next account", async () => {
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a");
  const connB = await seedConnection("guarded-conn-b", "sk-guarded-b");
  await seedGuardedCombo(connA.id, connB.id);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(502, { error: { message: "upstream glitch" } });
  };

  const response = await chatRoute.POST(makeRequest());

  assert.equal(response.status, 502, "non-matching response must surface unchanged");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1, "only the selected account A may be dispatched");
  assert.match(
    authorization(fetchCalls[0]?.init),
    /sk-guarded-a/,
    "the single dispatch must target account A"
  );
});

test("guarded-priority actual path: matching authoritative 503 advances only through the guarded executor", async () => {
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a");
  const connB = await seedConnection("guarded-conn-b", "sk-guarded-b");
  await seedGuardedCombo(connA.id, connB.id);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (/sk-guarded-a/.test(authorization(init))) {
      return upstream(503, { error: { message: "billing hard limit reached" } });
    }
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest());
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  assert.equal(response.status, 200, "matching 503 must let the guarded executor advance to B");
  assert.equal(body.choices[0].message.content, "FROM-B");
  assert.equal(fetchCalls.length, 2, "A then B both dispatched by the guarded executor");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-a/);
  assert.match(authorization(fetchCalls[1]?.init), /sk-guarded-b/);
});

test("guarded-priority actual path: post-combo non-matching 502 never invokes the global fallback model", async () => {
  await settingsDb.updateSettings({ globalFallbackModel: "openai/gpt-4.1-fallback" });
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a");
  await seedGuardedCombo(connA.id, null);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(502, { error: { message: "upstream glitch" } });
  };

  const response = await chatRoute.POST(makeRequest());

  assert.equal(response.status, 502, "the guarded 502 must surface to the client");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 1, "no global fallback may be dispatched");
  assert.match(authorization(fetchCalls[0]?.init), /sk-guarded-a/);
});

test("guarded-priority actual path: pre-dispatch 503 never invokes the global fallback model or the next account", async () => {
  await settingsDb.updateSettings({ globalFallbackModel: "openai/gpt-4.1-fallback" });
  const connA = await seedConnection("guarded-conn-a", "sk-guarded-a", {
    testStatus: "credits_exhausted",
    rateLimitedUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const connB = await seedConnection("guarded-conn-b", "sk-guarded-b");
  await seedGuardedCombo(connA.id, connB.id);

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest());

  assert.equal(response.status, 503, "pre-dispatch unavailability must fail closed");
  await flushBackgroundWork();
  assert.equal(fetchCalls.length, 0, "neither the next account nor global fallback may be called");
});

test("ordinary priority actual path still advances to the next account on 502", async () => {
  const connA = await seedConnection("plain-conn-a", "sk-plain-a");
  const connB = await seedConnection("plain-conn-b", "sk-plain-b");
  await seedGuardedCombo(connA.id, connB.id, {
    name: "plain-combo",
    strategy: "priority",
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (/sk-plain-a/.test(authorization(init))) {
      return upstream(502, { error: { message: "upstream glitch" } });
    }
    return upstream(200, OK_FROM_B);
  };

  const response = await chatRoute.POST(makeRequest("plain-combo"));
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  assert.equal(response.status, 200, "plain priority must still fail over to account B");
  assert.equal(body.choices[0].message.content, "FROM-B");
  assert.ok(
    fetchCalls.length >= 2,
    `plain priority must dispatch account B after A fails (got ${fetchCalls.length} calls)`
  );
  assert.match(
    authorization(fetchCalls[fetchCalls.length - 1]?.init),
    /sk-plain-b/,
    "the final dispatch must target account B"
  );
});

test("ordinary priority actual path still invokes the global fallback model when exhausted", async () => {
  await settingsDb.updateSettings({ globalFallbackModel: "openai/gpt-4.1-fallback" });
  const connA = await seedConnection("plain-conn-a", "sk-plain-a");
  await seedGuardedCombo(connA.id, null, {
    name: "plain-combo",
    strategy: "priority",
  });

  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (fetchCalls.length === 1) {
      // First dispatch is the combo's only model (connection A) → 502.
      return upstream(502, { error: { message: "upstream glitch" } });
    }
    // Any later dispatch is the configured global fallback model.
    return upstream(200, {
      id: "chatcmpl-fallback",
      choices: [{ message: { role: "assistant", content: "FROM-FALLBACK" } }],
    });
  };

  const response = await chatRoute.POST(makeRequest("plain-combo"));
  const body = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  assert.equal(
    body.choices[0].message.content,
    "FROM-FALLBACK",
    "plain priority may use the global fallback when its combo is exhausted"
  );
  assert.ok(
    fetchCalls.length >= 2,
    `plain priority must dispatch the global fallback after exhaustion (got ${fetchCalls.length} calls)`
  );
  assert.match(
    authorization(fetchCalls[0]?.init),
    /sk-plain-a/,
    "the first dispatch must target connection A"
  );
});

test("guarded-priority actual path: dynamic unpinned account group never internally advances A to B on a non-matching transient failure", async () => {
  const connA = await seedConnection("dyn-conn-a", "sk-dyn-a");
  const connB = await seedConnection("dyn-conn-b", "sk-dyn-b");
  await combosDb.createCombo({
    name: "dyn-combo",
    strategy: "guarded-priority",
    models: [
      {
        providerId: "openai",
        model: "gpt-4.1",
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 60_000,
      },
      {
        providerId: "openai",
        model: "gpt-4.1",
        connectionId: connB.id,
        offlineCondition: HARD_OFFLINE,
        offlineCooldownMs: 60_000,
      },
    ],
    config: { nestedComboMode: "execute", retryDelayMs: 0 },
  });
  const fetchCalls: { url: string; init?: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url: unknown, init?: Record<string, unknown>) => {
    fetchCalls.push({ url: String(url), init });
    if (/sk-dyn-a/.test(authorization(init))) {
      return upstream(502, { error: { message: "upstream glitch" } });
    }
    return upstream(200, OK_FROM_B);
  };
  const response = await chatRoute.POST(makeRequest("dyn-combo"));
  const bodyText = await response.text();
  assert.equal(response.status, 502, "non-matching transient failure must surface unchanged");
  assert.match(
    bodyText,
    /upstream glitch/,
    "the original account A response body must be returned untouched"
  );
  await flushBackgroundWork();
  assert.equal(
    fetchCalls.length,
    1,
    "the dynamic account group must NOT internally retry account B on a non-matching transient failure"
  );
  assert.match(
    authorization(fetchCalls[0]?.init),
    /sk-dyn-a/,
    "the single dispatch must be account A, and account B must never be selected inside handleSingleModelChat"
  );
});

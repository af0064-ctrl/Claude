import test from "node:test";
import assert from "node:assert/strict";

const {
  estimateSizeFast,
  isSmallEnoughForSemanticCache,
  ESTIMATE_SIZE_BYTE_LIMIT,
  ESTIMATE_SIZE_NODE_BUDGET,
} = await import("../../open-sse/utils/estimateSize.ts");

test("estimateSizeFast returns 0 for null/undefined", () => {
  assert.equal(estimateSizeFast(null), 0);
  assert.equal(estimateSizeFast(undefined), 0);
});

test("estimateSizeFast counts string lengths", () => {
  assert.equal(estimateSizeFast("hello"), 5);
  assert.equal(estimateSizeFast(""), 0);
});

test("estimateSizeFast counts numbers as 8 bytes", () => {
  assert.equal(estimateSizeFast(42), 8);
  assert.equal(estimateSizeFast(0), 8);
  assert.equal(estimateSizeFast(3.14), 8);
});

test("estimateSizeFast counts booleans as 4 bytes", () => {
  assert.equal(estimateSizeFast(true), 4);
  assert.equal(estimateSizeFast(false), 4);
});

test("estimateSizeFast walks arrays recursively", () => {
  const arr = ["abc", "de", 42];
  assert.equal(estimateSizeFast(arr), 3 + 2 + 8); // 13
});

test("estimateSizeFast walks objects recursively", () => {
  const obj = { a: "hello", b: 42 };
  assert.equal(estimateSizeFast(obj), 5 + 8); // 13
});

test("estimateSizeFast walks nested structures", () => {
  const nested = { messages: [{ role: "user", content: "hi" }] };
  // role=4, content=2
  assert.equal(estimateSizeFast(nested), 4 + 2); // 6
});

test("estimateSizeFast handles circular references without infinite loop", () => {
  const circular: Record<string, unknown> = { a: "test" };
  circular.self = circular; // Create circular ref
  // Should not hang — WeakSet skips already-visited objects
  const result = estimateSizeFast(circular);
  assert.equal(result, 4); // Only "test" (4) counted; circular ref skipped
});

test("estimateSizeFast handles deeply nested circular refs", () => {
  const a: Record<string, unknown> = { val: "x" };
  const b: Record<string, unknown> = { ref: a };
  a.back = b;
  const result = estimateSizeFast({ root: a });
  assert.equal(result, 1); // "x" = 1
});

test("estimateSizeFast early-exits at 262144 bytes (256KB)", () => {
  // Create a string > 256KB
  const bigStr = "x".repeat(300_000);
  const result = estimateSizeFast(bigStr);
  assert.ok(result >= 262144, `Should early-exit, got ${result}`);
});

test("estimateSizeFast accepts a custom earlyExitAt so a raised caller threshold is actually reachable", () => {
  // Bug: chatCore/logTruncation.ts's truncateForLog() compares estimateSizeFast's
  // result against a configurable threshold (getChatLogMaxBodyBytes(), default
  // 1MB) — but estimateSizeFast's own early-exit was hardcoded at 256KB. Many
  // small chunks (the realistic shape — a message array) stop accumulating the
  // instant the running total crosses the early-exit point, so with the old
  // hardcoded 256KB exit the reported size could never signal "still under a
  // 1MB threshold" for an object whose true size sits between the two.
  const chunks = Array.from({ length: 6000 }, () => "x".repeat(100)); // ~600KB true size
  const defaultResult = estimateSizeFast(chunks);
  assert.ok(
    defaultResult <= 262144 + 100,
    `default earlyExitAt should stop accumulating around 256KB, got ${defaultResult}`
  );
  const oneMbResult = estimateSizeFast(chunks, 1024 * 1024);
  assert.ok(
    oneMbResult > 262144,
    `with a 1MB earlyExitAt, ~600KB of chunks must be measurable past the old 256KB cap, got ${oneMbResult}`
  );
  assert.ok(
    oneMbResult <= 1024 * 1024 + 100,
    `should not exceed the true ~600KB size, got ${oneMbResult}`
  );
});

test("estimateSizeFast checks byte limit after numbers and booleans", () => {
  const almostForNumber = "x".repeat(ESTIMATE_SIZE_BYTE_LIMIT - 4);
  const withNumber = estimateSizeFast([almostForNumber, 1]);
  assert.ok(
    withNumber > ESTIMATE_SIZE_BYTE_LIMIT,
    `number contribution must trip byte limit, got ${withNumber}`
  );
  // boolean is 4 bytes: start 3 under the limit so adding true exceeds (not merely equals).
  const almostForBool = "x".repeat(ESTIMATE_SIZE_BYTE_LIMIT - 3);
  const withBool = estimateSizeFast([almostForBool, true]);
  assert.ok(
    withBool > ESTIMATE_SIZE_BYTE_LIMIT,
    `boolean contribution must trip byte limit, got ${withBool}`
  );
});

test("estimateSizeFast handles mixed object/array nesting", () => {
  const data = {
    choices: [
      {
        delta: { content: "Hello world" },
        index: 0,
      },
    ],
  };
  // content=11, index=8 (number), delta keys: content+delta=7, choices=8
  const result = estimateSizeFast(data);
  assert.ok(result > 0);
  assert.ok(result < 100);
});

test("estimateSizeFast does not count keys, only values", () => {
  // Object with long keys but short values
  const obj = { aLongKeyName: "x", anotherLongKeyName: "y" };
  assert.equal(estimateSizeFast(obj), 2); // "x" + "y"
});

test("isSmallEnoughForSemanticCache returns true for small payloads", () => {
  assert.ok(isSmallEnoughForSemanticCache({ msg: "hi" }));
});

test("isSmallEnoughForSemanticCache returns false for huge payloads", () => {
  const huge = { data: "x".repeat(300_000) };
  assert.ok(!isSmallEnoughForSemanticCache(huge));
});

test("isSmallEnoughForSemanticCache handles circular refs gracefully", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  // Should not hang; estimateSizeFast has WeakSet protection
  const result = isSmallEnoughForSemanticCache(circular);
  assert.equal(result, true); // 0 bytes < 256KB
});

test("estimateSizeFast handles Map-like objects (no infinite loop on iterables)", () => {
  const map = new Map<string, unknown>([["key", "value"]]);
  // Maps are objects but have no enumerable own properties via for-in
  const result = estimateSizeFast(map);
  assert.ok(typeof result === "number");
});

/**
 * Mutation-sensitive bound: a huge logical length with null/empty-object elements
 * must not pre-touch every index or allocate all references. Node-budget exhaustion
 * fails closed above 256 KiB so semantic-cache/admission never treat it as small.
 */
test("estimateSizeFast node budget fails closed on huge sparse null array without full traversal", () => {
  let elementAccesses = 0;
  const sparseNulls = new Proxy([] as unknown[], {
    get(target, prop, receiver) {
      if (prop === "length") return 5_000_000;
      if (prop === Symbol.iterator) {
        throw new Error("iterator must not be used");
      }
      if (typeof prop === "string" && /^[0-9]+$/.test(prop)) {
        elementAccesses += 1;
        return null;
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const result = estimateSizeFast(sparseNulls);
  assert.ok(
    result > ESTIMATE_SIZE_BYTE_LIMIT,
    `node-budget exhaustion must return >256KiB, got ${result}`
  );
  assert.ok(
    elementAccesses <= ESTIMATE_SIZE_NODE_BUDGET + 8,
    `must not access far beyond node budget; accesses=${elementAccesses}`
  );
  assert.ok(elementAccesses > 100, `expected many bounded visits, got ${elementAccesses}`);
  assert.equal(isSmallEnoughForSemanticCache(sparseNulls), false);
});

test("estimateSizeFast node budget fails closed on empty-object / getter proxy array", () => {
  let elementAccesses = 0;
  let farGetterHits = 0;
  const emptyObjectArray = new Proxy([] as unknown[], {
    get(target, prop, receiver) {
      if (prop === "length") return 2_000_000;
      if (typeof prop === "string" && /^[0-9]+$/.test(prop)) {
        const index = Number(prop);
        elementAccesses += 1;
        if (index >= ESTIMATE_SIZE_NODE_BUDGET) {
          farGetterHits += 1;
        }
        // Fresh empty object per access — old impl would stack-push every reference.
        return {};
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const result = estimateSizeFast(emptyObjectArray);
  assert.ok(result > ESTIMATE_SIZE_BYTE_LIMIT, `expected fail-closed, got ${result}`);
  assert.ok(
    elementAccesses <= ESTIMATE_SIZE_NODE_BUDGET + 8,
    `accesses must stay near node budget; got ${elementAccesses}`
  );
  assert.equal(
    farGetterHits,
    0,
    `entries beyond the node budget must not be touched; far hits=${farGetterHits}`
  );
  assert.equal(isSmallEnoughForSemanticCache(emptyObjectArray), false);
});

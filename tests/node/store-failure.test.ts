// G-14 store-failure flags: the pure derivation from a record's
// per-record counters (hadSuccess, consecutiveFailures).
import { describe, expect, it } from "vitest";
import { storeFailureFlags } from "../../src/state/storeFailure";

describe("storeFailureFlags", () => {
  it("no success yet, no failures: neither flag", () => {
    expect(storeFailureFlags(false, 0)).toEqual({
      storeNotAnswering: false,
      storeExhausted: false,
      storeSentence: "storeRetry",
    });
  });

  it("first GET fails (never succeeded): not answering is false — the status-error branch owns that case", () => {
    expect(storeFailureFlags(false, 1)).toEqual({
      storeNotAnswering: false,
      storeExhausted: false,
      storeSentence: "storeRetry",
    });
  });

  it("one failure after a prior success: not answering, not exhausted — keep the last good picture", () => {
    expect(storeFailureFlags(true, 1)).toEqual({
      storeNotAnswering: true,
      storeExhausted: false,
      storeSentence: "storeRetry",
    });
  });

  it("two consecutive failures after a prior success: not answering and exhausted — the ErrorState replaces the canvas", () => {
    expect(storeFailureFlags(true, 2)).toEqual({
      storeNotAnswering: true,
      storeExhausted: true,
      storeSentence: "storeRetry",
    });
  });

  it("three failures: still exhausted", () => {
    expect(storeFailureFlags(true, 3)).toEqual({
      storeNotAnswering: true,
      storeExhausted: true,
      storeSentence: "storeRetry",
    });
  });
});

it("uses the cause to choose the sentence", () => {
  expect(storeFailureFlags(true, 2, "pluginOff").storeSentence).toBe("storeBody");
  expect(storeFailureFlags(true, 2, "coded").storeSentence).toBe("storeBody");
  expect(storeFailureFlags(true, 2, "unreachable").storeSentence).toBe("storeRetry");
});

it("classifies serialized route and gateway failures", async () => {
  const { getScene, ApiError } = await import("../../src/api");
  const { failureCause } = await import("../../src/state/storeFailure");
  const failing = (message: string) => async <T>(): Promise<T> => { throw new Error(message); };
  let route: unknown;
  try { await getScene(failing('404: {"detail":"Not Found"}'), "x"); } catch (error) { route = error; }
  expect(failureCause(route)).toBe("pluginOff");
  let conflict: unknown;
  try { await getScene(failing('409: {"ok":false,"code":"REVISION_CONFLICT","message":"changed"}'), "x"); } catch (error) { conflict = error; }
  expect((conflict as InstanceType<typeof ApiError>).code).toBe("REVISION_CONFLICT");
  expect(failureCause(conflict)).toBe("coded");
});

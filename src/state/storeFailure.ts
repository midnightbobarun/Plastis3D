// src/state/storeFailure.ts — G-14 store-failure flags (pure).
//
// The scene/list records in sceneQuery.ts keep two counters per
// record: whether a GET ever succeeded in this session, and how many
// GETs have failed consecutively since. This module turns those
// counters into the two flags the surfaces read — pure, so Vitest
// covers it directly (sceneQuery.ts itself imports the SDK and cannot
// run in Node).
//
// A successful response resets the consecutive-failure count; two failures
// replace the canvas. The failure cause selects the accompanying sentence.

import { ApiError, API_ERROR_CODES } from "../api";
export type FailureCause = "pluginOff" | "unreachable" | "coded";
export function failureCause(error: unknown): FailureCause {
  if (error instanceof ApiError) {
    const transportCodes = ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH"];
    if (!Object.values(API_ERROR_CODES).includes(error.code as typeof API_ERROR_CODES[keyof typeof API_ERROR_CODES]) && !transportCodes.includes(error.code) && !error.code.startsWith("ERR_")) return "coded";
    // Hosts may expose only a message for route-level failures.
    if ([401, 403, 404].includes(error.status ?? 0) || /not found|\b40[134]\b/i.test(error.message)) return "pluginOff";
  }
  return "unreachable";
}
export function storeFailureFlags(
  hadSuccess: boolean,
  consecutiveFailures: number,
  cause: FailureCause = "unreachable",
): {
  storeNotAnswering: boolean;
  storeExhausted: boolean;
  storeSentence: "storeBody" | "storeRetry";
} {
  return {
    storeNotAnswering: hadSuccess && consecutiveFailures >= 1,
    storeExhausted: consecutiveFailures >= 2,
    storeSentence: cause === "unreachable" ? "storeRetry" : "storeBody",
  };
}

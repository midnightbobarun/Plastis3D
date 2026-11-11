import { expect, test, vi } from "vitest";
import { handoffPrompt } from "../../src/io/composerHandoff";

function fixture() {
  return {
    state: {
      focusedSessionId: { get: () => "runtime" },
      focusedStoredSessionId: { get: () => "stored" },
      focusedSessionProfile: { get: () => "profile" },
    },
    composer: { insertText: vi.fn(async () => true) },
    openSession: vi.fn(),
  };
}
test("inserts into the exact chat without replacing the draft or opening another chat", async () => {
  const host = fixture();
  expect(await handoffPrompt(host, "prompt")).toBe("inserted");
  expect(host.composer.insertText).toHaveBeenCalledExactlyOnceWith("stored", "prompt", { mode: "block" });
  expect(host.openSession).not.toHaveBeenCalled();
});
test("reveals the captured chat and waits for its composer without retargeting", async () => {
  const host = fixture();
  host.composer.insertText.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  host.openSession.mockImplementation(() => { host.state.focusedStoredSessionId.get = () => "other"; });
  expect(await handoffPrompt(host, "prompt", async () => {})).toBe("inserted");
  expect(host.openSession).toHaveBeenCalledWith("stored", { profile: "profile", intent: "in-place" });
  expect(host.composer.insertText.mock.calls).toEqual(Array(3).fill(["stored", "prompt", { mode: "block" }]));
});
test("bounds retries when the chat never mounts", async () => {
  const host = fixture();
  host.composer.insertText.mockResolvedValue(false);
  expect(await handoffPrompt(host, "prompt", async () => {})).toBe("no-composer");
  expect(host.composer.insertText).toHaveBeenCalledTimes(11);
});
test("older hosts and API failures are distinguishable", async () => {
  expect(await handoffPrompt({ state: {} }, "prompt")).toBe("unavailable");
  const host = fixture();
  host.composer.insertText.mockRejectedValue(new Error("bridge failed"));
  await expect(handoffPrompt(host, "prompt")).rejects.toThrow("bridge failed");
});

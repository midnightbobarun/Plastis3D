// tests/node/focusReturn.test.ts — 0-C cross-surface focus return (Tier 2).
//
// Covers src/editor/focusReturn.ts (the restore branching: invoker,
// then fallback, then nothing; never BODY) and src/editor/
// pendingDialog.ts (the 0-A subscription: a set notifies listeners so
// the Editor takes the pending dialog while already mounted). The
// node environment has no DOM, so restoreFocus is exercised with fake
// elements — the helper only reads `isConnected` and calls `focus()`.
// The harness spec (focus-return.spec.ts) drives the real DOM focus
// paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { restoreFocus, restoreFocusDeferred } from "../../src/editor/focusReturn";
import {
  peekPendingDialog,
  setPendingDialog,
  subscribePendingDialog,
  takePendingDialog,
} from "../../src/editor/pendingDialog";

function fakeElement(connected: boolean): {
  el: HTMLElement;
  focus: ReturnType<typeof vi.fn>;
} {
  const focus = vi.fn();
  const el = { isConnected: connected, focus } as unknown as HTMLElement;
  return { el, focus };
}

describe("restoreFocus", () => {
  it("focuses the invoker when it is connected", () => {
    const invoker = fakeElement(true);
    const fallback = fakeElement(true);
    restoreFocus(invoker.el, fallback.el);
    expect(invoker.focus).toHaveBeenCalledTimes(1);
    expect(fallback.focus).not.toHaveBeenCalled();
  });

  it("falls back when the invoker is null", () => {
    const fallback = fakeElement(true);
    restoreFocus(null, fallback.el);
    expect(fallback.focus).toHaveBeenCalledTimes(1);
  });

  it("falls back when the invoker is disconnected", () => {
    const invoker = fakeElement(false);
    const fallback = fakeElement(true);
    restoreFocus(invoker.el, fallback.el);
    expect(invoker.focus).not.toHaveBeenCalled();
    expect(fallback.focus).toHaveBeenCalledTimes(1);
  });

  it("does nothing when both are null", () => {
    expect(() => restoreFocus(null, null)).not.toThrow();
  });

  it("does nothing when both are disconnected", () => {
    const invoker = fakeElement(false);
    const fallback = fakeElement(false);
    restoreFocus(invoker.el, fallback.el);
    expect(invoker.focus).not.toHaveBeenCalled();
    expect(fallback.focus).not.toHaveBeenCalled();
  });
});

describe("restoreFocusDeferred", () => {
  const originalRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    // Node has no requestAnimationFrame; record the callback.
    globalThis.requestAnimationFrame = vi.fn(
      (_cb: FrameRequestCallback) => 1,
    ) as unknown as typeof requestAnimationFrame;
  });

  afterEach(() => {
    globalThis.requestAnimationFrame = originalRaf;
  });

  it("defers the restore to the frame callback", () => {
    const invoker = fakeElement(true);
    const fallback = fakeElement(true);
    restoreFocusDeferred(invoker.el, fallback.el);
    expect(invoker.focus).not.toHaveBeenCalled();
    expect(globalThis.requestAnimationFrame).toHaveBeenCalledTimes(1);
    const cb = (globalThis.requestAnimationFrame as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as FrameRequestCallback;
    cb(0);
    expect(invoker.focus).toHaveBeenCalledTimes(1);
    expect(fallback.focus).not.toHaveBeenCalled();
  });
});

describe("pending dialog subscription (0-A)", () => {
  beforeEach(() => {
    takePendingDialog();
  });

  afterEach(() => {
    takePendingDialog();
  });

  it("notifies subscribers on set, and take still drops the value", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingDialog(listener);
    setPendingDialog({
      kind: "new",
      sourceKey: "src-1",
      epoch: 3,
      invoker: null,
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(peekPendingDialog()).not.toBeNull();
    const taken = takePendingDialog();
    expect(taken?.kind).toBe("new");
    expect(peekPendingDialog()).toBeNull();
    unsubscribe();
  });

  it("an unsubscribed listener is not notified", () => {
    const listener = vi.fn();
    const unsubscribe = subscribePendingDialog(listener);
    unsubscribe();
    setPendingDialog({
      kind: "import",
      sceneId: "s1",
      sourceKey: "src-1",
      epoch: 3,
      invoker: null,
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("carries the invoker through set and take", () => {
    const { el } = fakeElement(true);
    setPendingDialog({
      kind: "new",
      sourceKey: "src-1",
      epoch: 3,
      invoker: el,
    });
    const taken = takePendingDialog();
    expect(taken?.invoker).toBe(el);
  });
});

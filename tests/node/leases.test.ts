import { beforeEach, expect, it, vi } from "vitest";
import { acquireLease, releaseLease, releaseAllLeases, liveLeaseCount, onLeaseFreed } from "../../src/scene/leases";
beforeEach(() => releaseAllLeases());
it("yields a card synchronously for an editor, preventing reentrant acquisition", () => {
  acquireLease("pane", "viewport");
  acquireLease("editor", "editor");
  const yieldCard = vi.fn(() => {
    releaseLease("card");
    expect(acquireLease("other-card", "card", () => {})).toBeNull();
  });
  acquireLease("card", "card", yieldCard);
  expect(acquireLease("tile", "editor")).not.toBeNull();
  expect(yieldCard).toHaveBeenCalledOnce();
  expect(liveLeaseCount()).toBe(3);
});
it("cards cannot preempt and must provide a yield callback", () => {
  for (let i = 0; i < 3; i++) acquireLease(String(i), "editor");
  expect(acquireLease("card", "card", () => {})).toBeNull();
  expect(() => acquireLease("bad", "card")).toThrow();
});
it("notifies subscribers after release and allows unsubscribe", async () => {
  acquireLease("pane", "viewport");
  const listener = vi.fn();
  const unsubscribe = onLeaseFreed(listener);
  releaseLease("pane");
  await Promise.resolve();
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
});
it("counts two editor mounts separately", () => {
  acquireLease("editor:one", "editor"); acquireLease("editor:two", "editor");
  expect(liveLeaseCount()).toBe(2);
  releaseLease("editor:one"); expect(liveLeaseCount()).toBe(1);
});

it("PR32: a release inside a card's yield is not broadcast (the slot is handed over)", async () => {
    releaseAllLeases();
    let freed = 0;
    const off = onLeaseFreed(() => {
      freed += 1;
    });
    acquireLease("editor:a", "editor");
    acquireLease("viewport:a", "viewport");
    acquireLease("card:a", "card", () => releaseLease("card:a"));
    // A second editor preempts the card: the card releases inside the yield.
    expect(acquireLease("editor:b", "editor")).not.toBeNull();
    await Promise.resolve();
    expect(freed).toBe(0);
    // A real release afterwards IS announced.
    releaseLease("editor:b");
    await Promise.resolve();
    expect(freed).toBe(1);
    off();
    releaseAllLeases();
  });

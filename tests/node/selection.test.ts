// tests/node/selection.test.ts — per-surface node selection (Tier 2, PR5).
//
// Covers src/state/selection.ts: select/toggle/range/primary/anchor.
// The store is plain TS + useSyncExternalStore, so Vitest tests it
// directly; the React hook (useSelection) is exercised by the harness.
import { describe, expect, it } from "vitest";
import { createSelectionStore } from "../../src/state/selection";

const ORDER = ["a", "b", "c", "d", "e"];

describe("selection store", () => {
  it("starts empty with a null primary", () => {
    const store = createSelectionStore();
    expect(store.getSnapshot()).toEqual({ ids: [], primary: null });
    expect(store.anchor()).toBeNull();
  });

  it("select replaces; the primary is the selected id", () => {
    const store = createSelectionStore();
    store.select("b");
    expect(store.getSnapshot()).toEqual({ ids: ["b"], primary: "b" });
    expect(store.anchor()).toBe("b");
    store.select("d");
    expect(store.getSnapshot()).toEqual({ ids: ["d"], primary: "d" });
  });

  it("selecting the same id twice is a no-op (no extra notify)", () => {
    const store = createSelectionStore();
    store.select("b");
    let bumps = 0;
    store.subscribe(() => {
      bumps += 1;
    });
    store.select("b");
    expect(bumps).toBe(0);
  });

  it("toggle adds and removes; the primary is the last added", () => {
    const store = createSelectionStore();
    store.select("a");
    store.toggle("c");
    expect(store.getSnapshot()).toEqual({ ids: ["a", "c"], primary: "c" });
    store.toggle("a");
    expect(store.getSnapshot()).toEqual({ ids: ["c"], primary: "c" });
    store.toggle("c");
    expect(store.getSnapshot()).toEqual({ ids: [], primary: null });
  });

  it("toggling the anchor off moves the anchor to the last id", () => {
    const store = createSelectionStore();
    store.select("a");
    store.toggle("b");
    expect(store.anchor()).toBe("b");
    store.toggle("b");
    expect(store.anchor()).toBe("a");
  });

  it("range-selects forward from the anchor in visible order", () => {
    const store = createSelectionStore();
    store.select("b");
    store.selectRange(store.anchor(), "d", ORDER);
    expect(store.getSnapshot().ids).toEqual(["b", "c", "d"]);
    expect(store.getSnapshot().primary).toBe("d");
  });

  it("range-selects backward from the anchor too", () => {
    const store = createSelectionStore();
    store.select("d");
    store.selectRange(store.anchor(), "b", ORDER);
    expect(store.getSnapshot().ids).toEqual(["b", "c", "d"]);
  });

  it("range-select keeps selection outside the range", () => {
    const store = createSelectionStore();
    store.select("a");
    store.toggle("e");
    store.selectRange("a", "c", ORDER);
    expect(store.getSnapshot().ids).toEqual(["e", "a", "b", "c"]);
  });

  it("range-select with no anchor or an unknown id is a plain select", () => {
    const store = createSelectionStore();
    store.selectRange(null, "c", ORDER);
    expect(store.getSnapshot()).toEqual({ ids: ["c"], primary: "c" });
    store.selectRange("a", "zz", ORDER);
    expect(store.getSnapshot()).toEqual({ ids: ["zz"], primary: "zz" });
  });

  it("set replaces the whole selection and moves the anchor to the last id", () => {
    const store = createSelectionStore();
    store.set(["c", "a"]);
    expect(store.getSnapshot()).toEqual({ ids: ["c", "a"], primary: "a" });
    expect(store.anchor()).toBe("a");
    store.set([]);
    expect(store.getSnapshot()).toEqual({ ids: [], primary: null });
    expect(store.anchor()).toBeNull();
  });

  it("remove drops one id and repairs the anchor; clear empties", () => {
    const store = createSelectionStore();
    store.set(["a", "b", "c"]);
    store.remove("c");
    expect(store.getSnapshot()).toEqual({ ids: ["a", "b"], primary: "b" });
    expect(store.anchor()).toBe("b");
    store.remove("zz");
    expect(store.getSnapshot().ids).toEqual(["a", "b"]);
    store.clear();
    expect(store.getSnapshot()).toEqual({ ids: [], primary: null });
  });

  it("notifies subscribers on change", () => {
    const store = createSelectionStore();
    let bumps = 0;
    const unsub = store.subscribe(() => {
      bumps += 1;
    });
    store.select("a");
    store.toggle("b");
    expect(bumps).toBe(2);
    unsub();
    store.select("c");
    expect(bumps).toBe(2);
  });

  it("getSnapshot() is referentially stable while unchanged (useSyncExternalStore)", () => {
    // Merge fix (PR5 report): React 19 loops until "Maximum update
    // depth exceeded" when getSnapshot() returns a fresh object on
    // every call. The snapshot must be the same reference until a
    // real change drops the cache.
    const store = createSelectionStore();
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    store.select("a");
    const afterSelect = store.getSnapshot();
    expect(afterSelect).not.toBe(first);
    expect(store.getSnapshot()).toBe(afterSelect);
    // No-op mutators keep the reference: re-selecting the same node
    // and setting the same ids do not bump.
    store.select("a");
    expect(store.getSnapshot()).toBe(afterSelect);
    store.set(["a"]);
    expect(store.getSnapshot()).toBe(afterSelect);
  });
});

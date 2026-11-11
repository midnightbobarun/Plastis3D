// tests/node/keybinds.test.ts — editor key map (Tier 2, PR5).
//
// Covers src/editor/keybindings.ts: the shouldIgnoreKey guard (T2: typing
// "water" in an input must not switch mode), resolveModeForSelection, and
// the root handler built by createEditorKeyHandler with fake events and
// fake targets (no DOM in Node).
import { describe, expect, it } from "vitest";
import {
  createEditorKeyHandler,
  resolveModeForSelection,
  shouldIgnoreKey,
} from "../../src/editor/keybindings";
import { createGizmoModeStore } from "../../src/gizmos/gizmoMode";
import { createSelectionStore } from "../../src/state/selection";
import { setGizmoDragging } from "../../src/state/dragLock";

type FakeTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
  blur?: () => void;
};

function fakeEvent(
  key: string,
  target: FakeTarget,
  opts?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean },
): KeyboardEvent {
  return {
    key,
    target: target as unknown as EventTarget,
    metaKey: opts?.metaKey ?? false,
    ctrlKey: opts?.ctrlKey ?? false,
    shiftKey: opts?.shiftKey ?? false,
    altKey: opts?.altKey ?? false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
}

const divTarget: FakeTarget = { tagName: "DIV", closest: () => null };
const inputTarget: FakeTarget = { tagName: "INPUT", closest: () => null };
const dialogTarget: FakeTarget = {
  tagName: "DIV",
  closest: (selector: string) =>
    selector === '[role="dialog"]' ? {} : null,
};

function makeHandler(opts?: {
  canUndo?: () => boolean;
  canRedo?: () => boolean;
}) {
  const gizmoMode = createGizmoModeStore();
  const selection = createSelectionStore();
  const calls: string[] = [];
  const handler = createEditorKeyHandler({
    gizmoMode,
    selection,
    getScene: () => ({ id: "s1", revision: 1 }),
    canUndo: opts?.canUndo ?? (() => true),
    canRedo: opts?.canRedo ?? (() => true),
    onToggleVisibility: () => calls.push("toggle-visibility"),
    onDeleteRequest: () => calls.push("delete"),
    onDuplicate: () => calls.push("duplicate"),
    onUndo: () => calls.push("undo"),
    onRedo: () => calls.push("redo"),
  });
  return { gizmoMode, selection, calls, handler };
}

describe("shouldIgnoreKey", () => {
  it("ignores form fields", () => {
    expect(shouldIgnoreKey(inputTarget as unknown as EventTarget)).toBe(true);
    expect(
      shouldIgnoreKey({ tagName: "TEXTAREA", closest: () => null } as unknown as EventTarget),
    ).toBe(true);
    expect(
      shouldIgnoreKey({ tagName: "SELECT", closest: () => null } as unknown as EventTarget),
    ).toBe(true);
    expect(
      shouldIgnoreKey({ isContentEditable: true, closest: () => null } as unknown as EventTarget),
    ).toBe(true);
  });

  it("ignores anything inside a dialog", () => {
    expect(shouldIgnoreKey(dialogTarget as unknown as EventTarget)).toBe(true);
  });

  it("does not ignore plain canvas targets or null", () => {
    expect(shouldIgnoreKey(divTarget as unknown as EventTarget)).toBe(false);
    expect(shouldIgnoreKey(null)).toBe(false);
  });
});

describe("resolveModeForSelection", () => {
  it("forces translate for rotate/scale with more than one node selected", () => {
    expect(resolveModeForSelection("rotate", 2)).toBe("translate");
    expect(resolveModeForSelection("scale", 3)).toBe("translate");
  });

  it("leaves single-node and select modes alone", () => {
    expect(resolveModeForSelection("rotate", 1)).toBe("rotate");
    expect(resolveModeForSelection("scale", 0)).toBe("scale");
    expect(resolveModeForSelection("translate", 2)).toBe("translate");
    expect(resolveModeForSelection("select", 2)).toBe("select");
  });
});

describe("createEditorKeyHandler (T2)", () => {
  it('typing "water" in an input does NOT switch mode', () => {
    const { gizmoMode, handler } = makeHandler();
    for (const letter of "water") {
      handler(fakeEvent(letter, inputTarget));
    }
    expect(gizmoMode.getSnapshot().mode).toBe("select");
  });

  it("W/E/R/Q switch modes on the canvas, with the multi-select rule", () => {
    const { gizmoMode, selection, handler } = makeHandler();
    handler(fakeEvent("w", divTarget));
    expect(gizmoMode.getSnapshot().mode).toBe("translate");
    handler(fakeEvent("e", divTarget));
    expect(gizmoMode.getSnapshot().mode).toBe("rotate");
    // Two nodes selected: E forces translate.
    selection.select("a");
    selection.toggle("b");
    handler(fakeEvent("e", divTarget));
    expect(gizmoMode.getSnapshot().mode).toBe("translate");
    handler(fakeEvent("r", divTarget));
    expect(gizmoMode.getSnapshot().mode).toBe("translate");
    handler(fakeEvent("q", divTarget));
    expect(gizmoMode.getSnapshot().mode).toBe("select");
  });

  it("F frames, G toggles the grid, H toggles the selection's visibility", () => {
    const { gizmoMode, calls, handler } = makeHandler();
    handler(fakeEvent("f", divTarget));
    expect(gizmoMode.getSnapshot().frameCounter).toBe(1);
    handler(fakeEvent("g", divTarget));
    expect(gizmoMode.getSnapshot().grid).toBe(false);
    handler(fakeEvent("h", divTarget));
    expect(calls).toEqual(["toggle-visibility"]);
  });

  it("Delete/Backspace request the delete confirm; Mod+Z/Mod+Shift+Z/Mod+D fire", () => {
    const { calls, handler } = makeHandler();
    handler(fakeEvent("Delete", divTarget));
    handler(fakeEvent("Backspace", divTarget));
    handler(fakeEvent("z", divTarget, { metaKey: true }));
    handler(fakeEvent("z", divTarget, { metaKey: true, shiftKey: true }));
    handler(fakeEvent("d", divTarget, { metaKey: true }));
    expect(calls).toEqual(["delete", "delete", "undo", "redo", "duplicate"]);
  });

  it("ignores alt-modified keys and keys inside a dialog", () => {
    const { gizmoMode, handler } = makeHandler();
    handler(fakeEvent("w", divTarget, { altKey: true }));
    handler(fakeEvent("w", dialogTarget));
    expect(gizmoMode.getSnapshot().mode).toBe("select");
  });

  it("ignores every chord while a gizmo drag is down", () => {
    const { gizmoMode, calls, handler } = makeHandler();
    setGizmoDragging(true);
    try {
      handler(fakeEvent("w", divTarget));
      handler(fakeEvent("z", divTarget, { metaKey: true }));
    } finally {
      setGizmoDragging(false);
    }
    expect(gizmoMode.getSnapshot().mode).toBe("select");
    expect(calls).toEqual([]);
  });

  it("Mod+Z / Mod+Shift+Z with empty history are silent no-ops (N-11)", () => {
    const { calls, handler } = makeHandler({
      canUndo: () => false,
      canRedo: () => false,
    });
    handler(fakeEvent("z", divTarget, { metaKey: true }));
    handler(fakeEvent("z", divTarget, { metaKey: true, shiftKey: true }));
    handler(fakeEvent("z", divTarget, { ctrlKey: true }));
    expect(calls).toEqual([]);
  });

  it("Mod+Z / Mod+Shift+Z fire when the gates are open (N-11)", () => {
    const { calls, handler } = makeHandler({
      canUndo: () => true,
      canRedo: () => true,
    });
    handler(fakeEvent("z", divTarget, { metaKey: true }));
    handler(fakeEvent("z", divTarget, { metaKey: true, shiftKey: true }));
    expect(calls).toEqual(["undo", "redo"]);
  });

  it("Escape blurs the target and changes nothing", () => {
    const { gizmoMode, handler } = makeHandler();
    let blurred = false;
    const target: FakeTarget = {
      tagName: "INPUT",
      closest: () => null,
      blur: () => {
        blurred = true;
      },
    };
    handler(fakeEvent("Escape", target));
    expect(blurred).toBe(true);
    expect(gizmoMode.getSnapshot().mode).toBe("select");
  });
});

import { describe, expect, it, vi } from "vitest";
import { createEditorKeyHandler } from "../../src/editor/keybindings";
import { createEditModeStore, editingStatus, IDLE_EDIT } from "../../src/state/editMode";
import { createGizmoModeStore } from "../../src/gizmos/gizmoMode";
import { createSelectionStore } from "../../src/state/selection";

function setup(active: boolean) {
  const editMode = createEditModeStore();
  const dispatched: unknown[] = [];
  editMode.setHandler((command) => dispatched.push(command));
  if (active) editMode.patch({ active: true });
  const deps = { onUndo: vi.fn(), onRedo: vi.fn(), onDeleteRequest: vi.fn(), onDuplicate: vi.fn(), onToggleVisibility: vi.fn() };
  const handler = createEditorKeyHandler({ editMode, gizmoMode: createGizmoModeStore(), selection: createSelectionStore(), getScene: () => ({ id: "s", revision: 1 }), canUndo: () => true, canRedo: () => true, ...deps });
  const press = (key: string, extra: Record<string, unknown> = {}) => handler({ key, target: null, preventDefault() {}, ...extra } as unknown as KeyboardEvent);
  return { press, dispatched, deps, editMode };
}

describe("the edit mode keys (M, 1/2/3, Delete, Mod+Z, Escape)", () => {
  it("M toggles, and does nothing else to the scene", () => {
    const { press, dispatched } = setup(false);
    press("m");
    expect(dispatched).toEqual([{ type: "toggle" }]);
  });

  it("1, 2 and 3 pick only while editing", () => {
    const idle = setup(false);
    idle.press("1");
    expect(idle.dispatched).toEqual([]);
    const { press, dispatched } = setup(true);
    press("1"); press("2"); press("3");
    expect(dispatched).toEqual([{ type: "pick", mode: "vertex" }, { type: "pick", mode: "edge" }, { type: "pick", mode: "face" }]);
  });

  it("Mod+Z steps the local edit while editing, and the scene history otherwise", () => {
    const edit = setup(true);
    edit.press("z", { metaKey: true });
    edit.press("z", { metaKey: true, shiftKey: true });
    expect(edit.dispatched).toEqual([{ type: "undo" }, { type: "redo" }]);
    expect(edit.deps.onUndo).not.toHaveBeenCalled();
    const idle = setup(false);
    idle.press("z", { metaKey: true });
    expect(idle.deps.onUndo).toHaveBeenCalledTimes(1);
  });

  it("Delete removes faces while editing, and asks to delete the node otherwise; Mod+D is off while editing", () => {
    const edit = setup(true);
    edit.press("Delete");
    edit.press("d", { metaKey: true });
    expect(edit.dispatched).toEqual([{ type: "delete" }]);
    expect(edit.deps.onDeleteRequest).not.toHaveBeenCalled();
    expect(edit.deps.onDuplicate).not.toHaveBeenCalled();
    const idle = setup(false);
    idle.press("Delete");
    expect(idle.deps.onDeleteRequest).toHaveBeenCalledTimes(1);
  });

  it("Escape leaves the mode (and bakes) while editing, but not from inside a field", () => {
    const edit = setup(true);
    edit.press("Escape");
    expect(edit.dispatched).toEqual([{ type: "toggle" }]);
    const field = setup(true);
    field.press("Escape", { target: { tagName: "INPUT", blur() {} } });
    expect(field.dispatched).toEqual([]);
  });

  it("B and P start Sculpt and Paint, or switch the tool inside a session; [ and ] resize the brush", () => {
    const idle = setup(false);
    idle.press("b"); idle.press("p");
    expect(idle.dispatched).toEqual([{ type: "tool", tool: "sculpt" }, { type: "tool", tool: "paint" }]);
    const { press, dispatched, editMode } = setup(true);
    editMode.patch({ tool: "sculpt", brush: { ...editMode.getSnapshot().brush, radius: 50 } });
    press("]"); press("[");
    expect(dispatched).toEqual([{ type: "brush", patch: { radius: 60 } }, { type: "brush", patch: { radius: 42 } }]);
    const mesh = setup(true);
    mesh.press("]");
    expect(mesh.dispatched).toEqual([]); // the mesh tool has no brush
  });

  it("the status line reads 'Editing — saves when you finish'", () => {
    expect(editingStatus(IDLE_EDIT)).toBeNull();
    expect(editingStatus({ ...IDLE_EDIT, active: true })).toBe("Editing — saves when you finish");
    expect(editingStatus({ ...IDLE_EDIT, active: true, busy: true })).toBe("Saving…");
  });

  it("the store keeps one pick mode and notifies subscribers once per real change", () => {
    const store = createEditModeStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.patch({ pick: "edge" });
    store.patch({ pick: "edge" });
    expect(seen).toHaveBeenCalledTimes(1);
    store.dispatch({ type: "pick", mode: "vertex" });
    expect(store.getSnapshot().pick).toBe("vertex");
  });
});

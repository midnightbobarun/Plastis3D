// src/state/sceneOrder.ts — the order scenes are listed in: newest edit first.
//
// The store lists scenes by file name, which looks random to a person. Everything that shows or picks "the
// first scene" (the picker, the Scenes pane, the scene the editor opens) reads the one sorted list, so they
// always agree. Equal or missing timestamps fall back to the name, then the id, so the order never flickers.
export function sortRecent<T extends { id: string; name: string; updatedAt?: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const ta = Date.parse(a.updatedAt ?? "") || 0;
    const tb = Date.parse(b.updatedAt ?? "") || 0;
    if (ta !== tb) return tb - ta;
    return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  });
}

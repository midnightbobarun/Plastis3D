// src/editor/querySceneId.ts — where the editor's `?scene=` lives (pure).
//
// F-UI-FIX-07 (step 5a): the real host is a HashRouter, and
// `host.navigate("/plastis3d?scene=<id>")` writes
// `location.hash = "#/plastis3d?scene=<id>"`. The query is then
// inside the hash, and `location.search` stays empty. The editor used
// to read only `location.search`, so in the live host every
// `?scene=` navigation was ignored (decisions file §6.2).
//
// Rule: the hash route's query wins when it carries `scene`. Otherwise
// fall back to the real search string. The fallback keeps the old URL
// shape working (`/?scene=<id>#/plastis3d`, the harness's original
// shape and the only one a hand-typed link could use before this fix).
// Pure, so Vitest covers it directly.

/** The `scene` query value from a hash route, or null. */
export function sceneIdFromHash(hash: string): string | null {
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  const q = route.indexOf("?");
  if (q < 0) return null;
  try {
    return new URLSearchParams(route.slice(q + 1)).get("scene");
  } catch {
    return null;
  }
}

/** The editor's requested scene id: hash query first, then search. */
export function querySceneId(hash: string, search: string): string | null {
  const fromHash = sceneIdFromHash(hash);
  if (fromHash !== null) return fromHash;
  try {
    return new URLSearchParams(search).get("scene");
  } catch {
    return null;
  }
}

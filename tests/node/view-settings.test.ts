import { expect, test } from "vitest";
import { initViewPrefs, getViewPrefs, setViewPrefs } from "../../src/state/viewPrefs";
test("view preferences persist, validate and isolate surfaces", () => {
 const values = new Map<string, unknown>();
 const storage = { get: <T,>(key: string, fallback: T) => (values.get(key) ?? fallback) as T, set: (key: string, value: unknown) => { values.set(key, value); } };
 initViewPrefs(storage);
 setViewPrefs({ background: "studio", grid: false, gridSize: 500, showHelpers: false });
 initViewPrefs(storage);
 expect(getViewPrefs()).toMatchObject({ background: "studio", grid: false, gridSize: 100, showHelpers: false });
 initViewPrefs(null);
 expect(getViewPrefs()).toMatchObject({ background: "gradient", grid: true, gridSize: 1, showHelpers: true });
});

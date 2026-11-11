import { expect, test } from "vitest";
import { cardSceneId } from "../../src/cards/cardAttrs";
test("only own valid scene strings pass", () => {
  for (const scene of ["", "../scene", "UPPER", "a".repeat(65)]) expect(cardSceneId({ scene })).toBeNull();
  expect(cardSceneId(Object.create({ scene: "valid" }))).toBeNull();
  expect(cardSceneId({ scene: "scene-123", ignored: "anything" })).toBe("scene-123");
});

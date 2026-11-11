import { expect, test } from "vitest";
import { reportCard } from "../../src/cards/nearestCard";
test("largest card wins, equal challenger holds, leaving promotes", () => {
  const events: string[] = [];
  const element = { compareDocumentPosition: () => 4 } as unknown as Element;
  const a = { element, height: 20, notify: (on: boolean) => events.push(`a:${on}`) };
  const b = { element, height: 30, notify: (on: boolean) => events.push(`b:${on}`) };
  reportCard("a", a); reportCard("b", b);
  expect(events).toEqual(["a:true", "a:false", "b:true"]);
  reportCard("a", { ...a, height: 30 });
  expect(events).toHaveLength(3);
  reportCard("b", null);
  expect(events.slice(-2)).toEqual(["b:false", "a:true"]);
  reportCard("a", null);
});

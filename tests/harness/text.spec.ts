import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

const bakes = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => String(r.path).endsWith("/bakes")));
const textNode = (page: Page) => page.evaluate(async () => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((n: any) => n.generator?.type === "text") ?? null);

test("Add > Text makes an editable text part in one step; editing and Apply bake once more; one undo restores the old text", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("button", { name: "Add", exact: true }).click();
  await route.getByRole("menuitem", { name: /Text/ }).or(route.getByRole("button", { name: "Text", exact: true })).first().click();
  await expect.poll(() => textNode(page), { timeout: 15000 }).not.toBeNull();
  let calls = await bakes(page);
  expect(calls.length).toBe(1);
  const created = calls[0].opts.body;
  expect(created.create.name).toBe("Text");
  expect(created.generator).toMatchObject({ type: "text", version: 1, params: { text: "Text", size: 0.2, align: "left", font: "bundled-sans-v1" } });
  expect(atob(created.mesh.indices).length / 12).toBeGreaterThan(50);
  const first = await textNode(page);
  expect(first.kind).toBe("part");
  const section = route.getByRole("region", { name: "Text", exact: true });
  await expect(section).toBeVisible({ timeout: 15000 });
  await expect(section.getByRole("status")).toContainText("Ready");
  // Edit the string and apply: one more bake, the same node.
  await section.getByLabel("Text to show").fill("Hello\nWorld");
  await expect(section.getByRole("button", { name: "Apply" })).toBeEnabled();
  await section.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await bakes(page)).length).toBe(2);
  calls = await bakes(page);
  expect(calls[1].opts.body.nodeId).toBe(first.id);
  expect(calls[1].opts.body.generator.params.text).toBe("Hello\nWorld");
  expect((await textNode(page)).generator.params.text).toBe("Hello\nWorld");
  // One undo restores the previous asset and its text.
  await route.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => (await textNode(page))?.generator?.params.text).toBe("Text");
});

test("a character the font lacks is named and cannot be applied; a size outside the range is refused before any request", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("button", { name: "Add", exact: true }).click();
  await route.getByRole("menuitem", { name: /Text/ }).or(route.getByRole("button", { name: "Text", exact: true })).first().click();
  const section = route.getByRole("region", { name: "Text", exact: true });
  await expect(section).toBeVisible({ timeout: 15000 });
  await section.getByLabel("Text to show").fill("A日B");
  await expect(section.getByRole("status")).toContainText("The bundled font has no glyph for: 日");
  await expect(section.getByRole("button", { name: "Apply" })).toBeDisabled();
  await section.getByLabel("Text to show").fill("AB");
  await section.getByLabel("Size (m)").fill("99");
  await expect(section.getByRole("button", { name: "Apply" })).toBeDisabled();
  const calls = await bakes(page);
  expect(calls.every((c: any) => c.opts.body.generator.params.size === 0.2)).toBe(true); // size 99 was never sent
});

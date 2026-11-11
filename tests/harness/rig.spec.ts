import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { gotoEditor } from "./pr5-helpers";

const rigs = (page: Page) => page.evaluate(() => (window.__plastis3dMock as any).restRequests.filter((r: any) => String(r.path).endsWith("/rigs")));
const node = (page: Page, name: string) => page.evaluate(async (n) => (await (window.__plastis3dMock as any).__rest("/scenes/demo-scene")).nodes.find((x: any) => x.name === n), name);

test("add two bones and a bend key, Apply: the shape becomes a locked model, one undo restores it", async ({ page }) => {
  await gotoEditor(page);
  const route = page.locator("#route");
  await route.getByRole("treeitem", { name: /^Box|Box/ }).first().click();
  const section = route.getByRole("region", { name: "Rig" });
  await expect(section).toBeVisible({ timeout: 15000 });
  await section.getByRole("button", { name: /Rig/ }).click(); // collapsed by default
  await expect(section.getByLabel("Name 1")).toHaveValue("Lower");
  await expect(section.getByLabel("Name 2")).toHaveValue("Upper");
  await section.getByLabel("Clip 1 key 2 rotation Z").fill("60");
  await section.getByRole("button", { name: "Add bone" }).click();
  await expect(section.getByLabel("Name 3")).toBeVisible();
  await section.getByLabel("Parent 1").selectOption("bone3"); // a loop: bone1 under bone3 under bone2 under bone1
  await expect(section.getByRole("status")).toContainText("loop");
  await expect(section.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
  await section.getByLabel("Parent 1").selectOption("");
  await section.getByRole("button", { name: "Apply", exact: true }).click();
  await expect.poll(async () => (await rigs(page)).length).toBe(1);
  const call = (await rigs(page))[0];
  expect(call.opts.body.rig.bones.length).toBe(3);
  expect(call.opts.body.rig.weights).toBe("envelope");
  const key = call.opts.body.rig.clips[0].keys[1];
  expect(key.rotation[2]).toBeCloseTo(Math.sin(Math.PI / 6), 4); // 60 degrees about Z: sin(30 deg)
  expect(typeof call.opts.body.mesh.positions).toBe("string");
  await expect.poll(async () => (await node(page, "Box"))?.kind).toBe("model");
  expect((await node(page, "Box")).generator.type).toBe("rig");
  await route.getByRole("button", { name: "Undo" }).first().click();
  await expect.poll(async () => (await node(page, "Box"))?.kind).toBe("mesh");
});

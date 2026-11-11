// tests/harness/save-drop.spec.ts — Mod+S saves; dropping a model file imports it (UI/UX polish W3).
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { gotoEditor, installErrorCollector, mockReport } from "./pr5-helpers";

type Page = import("@playwright/test").Page;

async function focusEditor(page: Page): Promise<void> {
  await page.locator("[data-plastis-root=editor]").focus();
}

/** Dispatch a file drop (dragover first, as a browser does) on an element. */
async function dropFile(page: Page, selector: string, name: string, bytes: number[]): Promise<void> {
  await page.evaluate(
    ([sel, fileName, data]) => {
      const target = document.querySelector(sel as string) as HTMLElement;
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(data as number[])], fileName as string));
      for (const type of ["dragenter", "dragover", "drop"]) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
      }
    },
    [selector, name, bytes] as [string, string, number[]],
  );
}

test("Mod+S runs Save as GLB with the same export request as the button", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  await focusEditor(page);
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForFunction(
    () => (window.__plastis3dMock as unknown as { downloads: unknown[] }).downloads.length === 1,
    undefined,
    { timeout: 15000 },
  );
  const report = await mockReport(page);
  expect(
    report.restRequests.some(
      (r) => r.path === "/scenes/demo-scene/export" && (r.opts as { method?: string } | undefined)?.method === "POST",
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("Mod+S does nothing while a dialog is open", async ({ page }) => {
  await gotoEditor(page);
  await focusEditor(page);
  // Dialog open: Import's dialog takes the keys.
  await page.getByRole("button", { name: "Open a model" }).click();
  const dialog = page.getByRole("dialog", { name: "Import a model" });
  await expect(dialog).toBeVisible();
  await dialog.getByText("Import using a path").click();
  await dialog.getByLabel("Path on the Hermes computer").focus();
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(600);
  expect((await mockReport(page)).downloads).toHaveLength(0);
});

test("Mod+S does nothing while a mesh is being edited", async ({ page }) => {
  await gotoEditor(page);
  await page.locator("#route").getByRole("treeitem", { name: /Box/ }).first().click();
  await page.locator("#route").getByRole("button", { name: "Edit mesh (M)" }).click();
  await expect(page.locator("#route .p3d-edit-bar")).toBeVisible();
  await focusEditor(page);
  await page.keyboard.press("ControlOrMeta+s");
  await page.waitForTimeout(800);
  expect((await mockReport(page)).downloads).toHaveLength(0);
});

test("dropping a model file opens Import and posts the upload", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  const bytes = Array.from(readFileSync("tests/fixtures/two-primitive.glb"));
  await dropFile(page, "[data-plastis-root=editor]", "dropped.glb", bytes);
  await expect
    .poll(async () => {
      const report = await mockReport(page);
      return report.restRequests.find((r) => r.path === "/scenes/demo-scene/imports");
    }, { timeout: 15000 })
    .toBeTruthy();
  const post = (await mockReport(page)).restRequests.find((r) => r.path === "/scenes/demo-scene/imports");
  const upload = (post!.opts as { body: { upload: { filename: string; contentType: string } } }).body.upload;
  expect(upload.filename).toBe("dropped.glb");
  expect(upload.contentType).toBe("model/gltf-binary");
  await expect(page.getByRole("dialog", { name: "Import a model" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("dropping something that is not a model warns and imports nothing", async ({ page }) => {
  await gotoEditor(page);
  await dropFile(page, "[data-plastis-root=editor]", "notes.txt", [104, 105]);
  await expect
    .poll(async () => (await mockReport(page)).notifications.some((n) => n.message.includes("Drop a GLB")))
    .toBe(true);
  const report = await mockReport(page);
  expect(report.restRequests.some((r) => r.path.endsWith("/imports"))).toBe(false);
});

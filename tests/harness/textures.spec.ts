// tests/harness/textures.spec.ts — Tier 4 texture maps (PR15).
//
// The Maps block in the material section, the image picker (the import
// dialog in image mode: the same folder door and path door), the view
// drawing the picture, and Clear. The mock host stands in for the gateway:
// POST /scenes/{id}/images makes one revision, GET /assets serves a 4 x 4
// pattern PNG. The WebGL texture count in the editor telemetry proves the
// view really uploaded the texture and really released it.
//
// What this cannot prove (live check, queued): that the gateway stores the
// bytes, and the picture's orientation on a real GPU. The orientation
// contract is pinned by tests/node/primitive-uv.test.ts and
// tests/python/test_textures.py.
import { expect, test } from "@playwright/test";
import {
  clickWorldPoint,
  editorTelemetry,
  gotoEditor,
  installErrorCollector,
  mockReport,
  patchRequests,
  waitForEditorPrimary,
} from "./pr5-helpers";

type Page = import("@playwright/test").Page;

async function selectBox(page: Page) {
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  const maps = page.locator("#route").getByRole("group", { name: "Maps" });
  await expect(maps).toBeVisible();
  await expect(maps.getByText("Picture", { exact: true })).toBeVisible();
  return maps;
}

async function textureCount(page: Page): Promise<number> {
  return (await editorTelemetry(page))?.textures ?? -1;
}

async function imagePosts(page: Page) {
  const report = await mockReport(page);
  return report.restRequests
    .filter((r) => r.path.endsWith("/images"))
    .map((r) => (r.opts as { body: Record<string, unknown> }).body);
}

async function pickByPath(page: Page, slotLabel: string, path: string) {
  await page.locator("#route").getByRole("button", { name: `Choose ${slotLabel} image` }).click();
  const dialog = page.getByRole("dialog", { name: "Choose an image" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Path on the Hermes computer").fill(path);
  await dialog.getByRole("button", { name: "Use this image" }).click();
  return dialog;
}

test("Textures is its own section and lists the four slots, each empty", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  await clickWorldPoint(page, [0, 0.5, 0], undefined, "#route canvas");
  await waitForEditorPrimary(page, "n_box");
  await expect(page.locator("#route").getByRole("region", { name: "Textures" })).toBeVisible();
  const maps = await selectBox(page);
  for (const title of ["Picture", "Bumps", "Shine and metal", "Glow picture"]) {
    await expect(maps.getByText(title, { exact: true })).toBeVisible();
  }
  await expect(maps.getByText("None")).toHaveCount(4);
  await expect(maps.getByRole("button", { name: /^Choose / })).toHaveCount(4);
  await expect(maps.getByRole("button", { name: /^Clear / })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("choosing a picture by path puts it on the slot in one request and the view draws it", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  const maps = await selectBox(page);
  const before = await textureCount(page);

  const dialog = await pickByPath(page, "picture", "/pics/wood.png");
  await expect(dialog).toBeHidden();

  const posts = await imagePosts(page);
  expect(posts).toHaveLength(1);
  expect(posts[0]).toMatchObject({ slot: "baseColorMap", backendPath: "/pics/wood.png" });
  expect(typeof posts[0].baseRevision).toBe("number");

  // The tile now names the picture and shows a preview.
  const tile = maps.locator('[data-slot="baseColorMap"]');
  await expect(tile.getByText("wood.png · 4 × 4")).toBeVisible();
  await expect(tile.locator("img")).toBeVisible();
  await expect(tile.getByRole("button", { name: "Replace picture image" })).toBeVisible();
  // The view fetched the image through the byte route and uploaded a texture.
  await expect.poll(async () => (await mockReport(page)).imageFetches.length).toBeGreaterThan(0);
  await expect.poll(() => textureCount(page), { timeout: 10000 }).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test("Clear removes the map in one PATCH, and choosing the same picture again reuses the decoded texture", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  const maps = await selectBox(page);
  const before = await textureCount(page);
  await (await pickByPath(page, "picture", "/pics/wood.png")).waitFor({ state: "hidden" });
  await expect.poll(() => textureCount(page), { timeout: 10000 }).toBeGreaterThan(before);
  const withTexture = await textureCount(page);
  const fetchesAfterFirst = (await mockReport(page)).imageFetches.length;

  const patchesBefore = (await patchRequests(page)).length;
  await maps.getByRole("button", { name: "Clear picture image" }).click();
  await expect.poll(async () => (await patchRequests(page)).length).toBe(patchesBefore + 1);
  const patch = (await patchRequests(page)).at(-1)!;
  expect(patch.body.ops).toHaveLength(1);
  expect(patch.body.ops[0].op).toBe("set_material");
  expect((patch.body.ops[0].material as Record<string, unknown>).baseColorMap).toBeNull();

  await expect(maps.getByText("None")).toHaveCount(4);
  // The decoded texture stays cached while there is room (it is unused, not leaked) ...
  expect(await textureCount(page)).toBeLessThanOrEqual(withTexture);
  // ... so the same picture again binds at once: no new GPU texture, no second fetch for the view.
  const dialog = await pickByPath(page, "picture", "/pics/wood.png");
  await expect(dialog).toBeHidden();
  await expect(maps.getByText("wood.png · 4 × 4")).toBeVisible();
  await expect.poll(() => textureCount(page), { timeout: 10000 }).toBe(withTexture);
  const report = await mockReport(page);
  // The Maps preview fetches for its thumbnail; the view must not fetch it again.
  expect(report.imageFetches.length - fetchesAfterFirst).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test("a refused image keeps the dialog open and says why", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  await selectBox(page);
  await page.evaluate(() =>
    (window as unknown as { __plastis3dMock: { __refuseNextImage: (c: string, m: string) => void } })
      .__plastis3dMock.__refuseNextImage(
        "TEXTURE_NO_UV",
        "part 'Leg' has no UV coordinates, so material 'm_x' cannot put a texture on it",
      ),
  );
  const dialog = await pickByPath(page, "picture", "/pics/wood.png");
  await expect(dialog.getByRole("alert")).toContainText("has no UV coordinates");
  await expect(dialog).toBeVisible();
  expect(await imagePosts(page)).toHaveLength(1);

  await page.evaluate(() =>
    (window as unknown as { __plastis3dMock: { __refuseNextImage: (c: string, m: string) => void } })
      .__plastis3dMock.__refuseNextImage("IMPORT_FORMAT", "only PNG and JPEG"),
  );
  await dialog.getByRole("button", { name: "Use this image" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Plastis3D reads PNG and JPEG pictures as textures.");
  expect(errors).toEqual([]);
});

test("the folder door lists pictures only and posts the chosen one as base64", async ({ page }) => {
  const errors = installErrorCollector(page);
  await gotoEditor(page);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAHklEQVR4nGP4z8DwX87mxH8QANEMyBwQYEDmYFUBAPAmLuuAWck5AAAAAElFTkSuQmCC",
    "base64",
  );
  await page.evaluate(
    ({ listing, files }) => {
      const mock = (window as unknown as { __plastis3dMock: { __files: unknown; __remount: () => Promise<void> } })
        .__plastis3dMock;
      mock.__files = { folders: [{ id: "folder-1", name: "Pictures", path: "/pics" }], listing, files };
      return mock.__remount();
    },
    {
      listing: [
        { name: "wood.png", path: "wood.png", isDirectory: false },
        { name: "Photo.JPG", path: "Photo.JPG", isDirectory: false },
        { name: "chair.glb", path: "chair.glb", isDirectory: false },
        { name: "notes.txt", path: "notes.txt", isDirectory: false },
        { name: ".hidden.png", path: ".hidden.png", isDirectory: false },
      ],
      files: {
        "wood.png": { size: png.length, dataUrl: `data:image/png;base64,${png.toString("base64")}` },
      },
    },
  );
  await expect(page.locator("[data-plastis-root=editor]")).toBeVisible({ timeout: 15000 });
  await selectBox(page);
  await page.locator("#route").getByRole("button", { name: "Choose bumps image" }).click();
  const dialog = page.getByRole("dialog", { name: "Choose an image" });
  await expect(dialog.getByRole("button", { name: "wood.png" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Photo.JPG" })).toBeVisible();
  for (const hidden of ["chair.glb", "notes.txt", ".hidden.png"]) {
    await expect(dialog.getByRole("button", { name: hidden })).toHaveCount(0);
  }
  await dialog.getByRole("button", { name: "wood.png" }).click();
  await expect(dialog).toBeHidden();
  const [post] = await imagePosts(page);
  const upload = post.upload as { filename: string; contentType: string; bytes: string };
  expect(post.slot).toBe("normalMap");
  expect(upload.filename).toBe("wood.png");
  expect(upload.contentType).toBe("image/png");
  expect(upload.bytes).toBe(png.toString("base64")); // base64 text, not an array of numbers
  expect(errors).toEqual([]);
});

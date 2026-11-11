import { expect, test } from "@playwright/test";

test("animated model resources return to baseline after repeated scene disposal", async ({ page }) => {
  await page.goto("/tests/harness/clip-dispose.html");
  const result = page.locator("#result");
  await expect(result).not.toHaveText("running", { timeout: 30000 });
  const value = JSON.parse((await result.textContent()) ?? "{}");
  expect(value.error).toBeUndefined();
  expect(value.after).toEqual(value.baseline);
});

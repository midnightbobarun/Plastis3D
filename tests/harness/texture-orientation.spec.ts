import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: [`--use-angle=${process.platform === 'win32' ? 'd3d11' : 'metal'}`, "--ignore-gpu-blocklist"] } });
test.skip(process.platform !== "darwin" && process.platform !== "win32", "Real-GPU orientation oracle runs on macOS (Metal) and Windows (D3D11)");

test("asymmetric PNG stays upright on all six cube faces through the browser texture decoder", async ({ page }) => {
  await page.goto("/tests/harness/texture-orientation.html");
  const result = page.locator("#result");
  await expect(result).not.toHaveText("Running");
  const report = JSON.parse(await result.innerText());
  expect(report.error).toBeUndefined();
  expect(report.results).toHaveLength(6);
  for (const { face, colors } of report.results) {
    for (const [index, expected] of [[0, [true, false, false]], [1, [false, true, false]], [2, [false, false, true]], [3, [true, true, false]]] as const) {
      expect(colors[index].map((channel: number) => channel > 50), `${face} quadrant ${index}: ${colors[index]}`).toEqual(expected);
    }
  }
});

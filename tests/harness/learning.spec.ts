import { test, expect } from "@playwright/test";
import { gotoMock, mockReport } from "./pr5-helpers";
test("prompt chips insert without sending, with clipboard fallback", async ({ page }) => {
 await gotoMock(page);
 await page.getByRole('button', { name: 'In Plastis3D scene demo-scene: Make this scene feel like evening' }).count();
 await page.locator('[data-plastis-root=editor]').locator('.p3d-ask > summary').click();
 await page.locator('[data-plastis-root=editor]').getByRole('button', { name: 'Make this scene feel like evening' }).click();
 await expect.poll(() => page.evaluate(() => (window as any).__copiedPrompt)).toContain('demo-scene');
 await expect(page.locator('.p3d-learning')).toContainText('Getting started');
});
test("shortcut sheet and snap controls are local editor help", async ({ page }) => {
 await gotoMock(page);
 await page.getByRole('button', { name: 'Keyboard shortcuts', exact: true }).click();
 await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
 await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByRole('button', { name:'Close' }).click();
 await page.locator('.p3d-snap summary').click();
 await page.getByLabel('Enable snapping').check();
 await page.getByLabel('Move (m)', { exact:true }).fill('0.25');
 await expect(page.getByLabel('Move (m)', { exact:true })).toHaveValue('0.25');
});
test("external tool revisions show changed nodes and Undo last keeps earlier work", async ({ page }) => {
 await gotoMock(page);
 await page.evaluate(async () => {
   const mock = (window as any).__plastis3dMock;
   await mock.__rest('/scenes/demo-scene', { method:'PATCH', body:{ baseRevision:1, ops:[{ op:'update_node', id:'n_box', transform:{ t:[2,0,0] } }] } });
   mock.__emit('plugin.plastis3d.scene.changed', { scene:'demo-scene', revision:2, origin:'tool' });
 });
 const bar = page.locator('.p3d-agent-bar');
 await expect(bar).toContainText('Hermes updated the scene');
 await expect(bar).toContainText('1 changes');
 await page.evaluate(async () => {
   const mock = (window as any).__plastis3dMock;
   await mock.__rest('/scenes/demo-scene', { method:'PATCH', body:{ baseRevision:2, ops:[{ op:'set_scene_name', name:'Remote rename' }] } });
   mock.__emit('plugin.plastis3d.scene.changed', { scene:'demo-scene', revision:3, origin:'ui' });
 });
 await expect(bar).toContainText('The scene was updated');
 await bar.getByRole('button', { name:'Undo last', exact:true }).click();
 await expect.poll(() => page.evaluate(async () => {
   const sc = await (window as any).__plastis3dMock.__rest('/scenes/demo-scene');
   return sc.nodes.find((node:any)=>node.id==='n_box').transform.t[0];
 })).toBe(2);
});
test("scene rename is a revisioned mutation", async ({ page }) => {
 await gotoMock(page);
 await page.locator('[data-plastis-root=editor]').getByRole('button', { name: /Demo Scene/ }).first().click();
 await page.getByRole('menuitem', { name: 'Rename scene', exact: true }).click();
 const name = page.locator('[data-plastis-root=editor]').getByRole('textbox', { name:'Scene name', exact:true });
 await name.fill('My renamed scene'); await name.press('Enter');
 await expect.poll(async () => (await mockReport(page)).restRequests.some((r:any)=>r.opts?.body?.ops?.[0]?.op==='set_scene_name')).toBe(true);
});
test("with the editor open the pane carries outline and properties, the editor only the view", async ({ page }) => {
 await gotoMock(page);
 await page.evaluate(() => { (window as any).__plastis3dMock.collapsePane = true; });
 await page.evaluate(() => (window as any).__plastis3dMock.__remount?.());
 const side = page.locator('[data-plastis-root=sidepanel]');
 await expect(side).toContainText('Triangles');
 await expect(side.getByRole('region', { name: 'Scene outline' })).toBeVisible();
 await expect(page.locator('[data-plastis-root=editor]')).not.toContainText('Triangles');
 await expect(page.locator('[data-plastis-root=pane] canvas')).toHaveCount(0);
});
test("editor shortcuts work while focus is in the side panel", async ({ page }) => {
 await gotoMock(page);
 await page.evaluate(() => { (window as any).__plastis3dMock.collapsePane = true; });
 await page.evaluate(() => (window as any).__plastis3dMock.__remount?.());
 const side = page.locator('[data-plastis-root=sidepanel]');
 await side.getByRole('treeitem', { name: /Box/ }).first().click();
 await page.keyboard.press('h');
 await expect.poll(async () => (await mockReport(page)).restRequests.some((r:any)=>r.opts?.method==='PATCH' && JSON.stringify(r.opts?.body).includes('visible'))).toBe(true);
});

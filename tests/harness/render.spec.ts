import { expect, test } from '@playwright/test';
import { gotoEditor } from './pr5-helpers';
test.use({launchOptions:{args:[`--use-angle=${process.platform === 'win32' ? 'd3d11' : 'metal'}`,'--ignore-gpu-blocklist']}});
test.skip(process.platform !== 'darwin' && process.platform !== 'win32', 'Hardware GPU verification runs on macOS (Metal) and Windows (D3D11)');
  test('samples accumulate, camera motion resets and Save posts once',async({page})=>{
    await gotoEditor(page);const route=page.locator('#route');
    const render=route.getByRole('button',{name:'Render',exact:true});
    await expect(render).toBeEnabled({timeout:20000});await render.click();
    const counter=route.getByText(/\d+ \/ 256 samples/);
    await expect(counter).toBeVisible();
    await expect.poll(async()=>Number((await counter.innerText()).match(/\d+/)?.[0])).toBeGreaterThan(3);
    const before=Number((await counter.innerText()).match(/\d+/)?.[0]);
    const canvas=route.locator('canvas').first();const box=await canvas.boundingBox();
    await page.mouse.move(box!.x+box!.width/2,box!.y+box!.height/2);await page.mouse.down();await page.mouse.move(box!.x+box!.width/2+100,box!.y+box!.height/2,{steps:8});await page.mouse.up();
    await expect.poll(async()=>Number((await counter.innerText()).match(/\d+/)?.[0])).toBeLessThan(before+2);
    await expect(route.getByRole('button',{name:'Save image…',exact:true})).toBeEnabled();
    await route.getByRole('button',{name:'Save image…',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>(window.__plastis3dMock as any).restRequests.filter((r:any)=>r.path.endsWith('/renders')).length)).toBe(1);
    await expect.poll(()=>page.evaluate(()=>(window.__plastis3dMock as any).downloads.filter((d:any)=>d.path.endsWith('.png')).length)).toBe(1);
    await route.getByRole('button',{name:'Back to editing'}).click();await expect(render).toBeVisible();
  });

test('Gaussian ellipsoids draw and sort far-to-near on the hardware GPU',async({page})=>{
  await page.goto('/tests/harness/splats.html');
  const result=page.locator('#result');await expect(result).not.toHaveText('Running');
  const [red,green,blue,alpha]=JSON.parse(await result.innerText());
  expect(red).toBeGreaterThan(blue);expect(red).toBeGreaterThan(20);expect(green).toBe(0);expect(alpha).toBeGreaterThan(0);
});

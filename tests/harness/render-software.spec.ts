import { expect, test } from '@playwright/test';
import { gotoEditor } from './pr5-helpers';
test.use({launchOptions:{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}});
test('Render explains a software GPU',async({page})=>{await gotoEditor(page);const route=page.locator('#route');await expect(route.getByRole('button',{name:'Render',exact:true})).toBeDisabled();await route.getByRole('button',{name:'About Render'}).click();await expect(route.getByText(/requires? a hardware GPU/)).toBeVisible();});

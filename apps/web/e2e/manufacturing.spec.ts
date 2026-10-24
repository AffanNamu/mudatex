import { expect, test, type Page } from '@playwright/test';
import { noA11yViolations, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const section = (page: Page, name: string) => page.getByRole('navigation', { name: 'Manufacturing sections' }).getByRole('link', { name });
async function go(page: Page, tab: string) {
  await nav(page).getByRole('link', { name: 'Manufacturing' }).click();
  await section(page, tab).click();
}
const as = async (browser: import('@playwright/test').Browser, email: string) => {
  const page = await (await browser.newContext()).newPage();
  await signIn(page, email);
  return page;
};

test('a BOM is drafted by one person and approved by another, then checks material for a run', async ({ browser }) => {
  const maker = await as(browser, 'bom-maker@e2e.test');
  await go(maker, 'Bills of materials');
  await maker.getByText('New bill of materials').click();
  await maker.getByLabel('Finished product').selectOption({ label: 'Shirt (SHT-001)' });
  await maker.getByLabel('Quality check').check();
  await maker.getByLabel('Material 1').selectOption({ label: 'Calico (CAL-001)' });
  await maker.getByLabel('Quantity 1').fill('2');
  await maker.getByLabel('Allowed waste % 1').fill('5');
  await maker.getByRole('button', { name: 'Add a material' }).click();
  await maker.getByLabel('Material 2').selectOption({ label: 'Button (BTN-001)' });
  await maker.getByLabel('Quantity 2').fill('6');
  await maker.getByRole('button', { name: 'Add a step' }).click();
  await maker.getByLabel('Step 1 name').fill('Cut');
  await maker.getByLabel('Step 1 work centre').selectOption({ label: 'CUT Cutting table' });
  await maker.getByLabel('Step 1 setup minutes').fill('10');
  await maker.getByLabel('Step 1 minutes per unit').fill('2.5');
  await maker.getByRole('button', { name: 'Add a step' }).click();
  await maker.getByLabel('Step 2 name').fill('Sew');
  await maker.getByLabel('Step 2 work centre').selectOption({ label: 'SEW Sewing line' });
  await maker.getByLabel('Step 2 minutes per unit').fill('4');
  await noA11yViolations(maker);
  await maker.getByRole('button', { name: 'Save as draft' }).click();
  await expect(maker.getByRole('heading', { level: 2, name: /Shirt \(SHT-001\) · v1 · draft/ })).toBeVisible();
  await expect(maker.getByRole('button', { name: 'Approve' })).toHaveCount(0);   // makers do not approve

  const approver = await as(browser, 'bom-approver@e2e.test');
  await go(approver, 'Bills of materials');
  await approver.getByRole('button', { name: /Shirt \(SHT-001\)/ }).click();
  await approver.getByRole('button', { name: 'Approve' }).click();
  await expect(approver.getByRole('heading', { level: 2, name: /v1 · active/ })).toBeVisible();

  // How much material would 100 shirts need, and is it there?
  await approver.getByLabel('How many to make').fill('100');
  const check = approver.getByRole('region', { name: 'Material check' });
  await expect(check.getByText('All material is free to reserve.')).toBeVisible();
  await expect(check.getByRole('row', { name: /CAL-001/ }).getByRole('cell').first()).toHaveText('210');   // 2 × 100 × 1.05 waste
  await expect(check.getByRole('row', { name: /BTN-001/ }).getByRole('cell').first()).toHaveText('600');
  await approver.getByLabel('How many to make').fill('1000');
  await expect(check.getByText(/Short even after open purchase orders/)).toBeVisible();
});

test('a planner reserves material; a run that cannot be covered is refused with the shortage listed', async ({ page }) => {
  await signIn(page, 'planner@e2e.test');
  await go(page, 'Work orders');
  await page.getByText('New work order').click();
  await page.getByLabel('Quantity to make').fill('1000');   // needs 2,100 calico, only 500 exist
  await page.getByRole('button', { name: 'Create work order' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /WO-000001 · Draft/ })).toBeVisible();
  await page.getByRole('button', { name: 'Release and reserve material' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Not enough free material');
  await expect(alert).toContainText('CAL-001: needs 2100, 500 free, short by 1600');
  await page.getByRole('button', { name: 'Cancel order' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /WO-000001 · Cancelled/ })).toBeVisible();

  await page.getByRole('button', { name: '← All work orders' }).click();
  await page.getByText('New work order').click();
  await page.getByLabel('Quantity to make').fill('100');
  await page.getByRole('button', { name: 'Create work order' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /WO-000002 · Draft/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Calico/ }).getByRole('cell').first()).toHaveText('210');
  await page.getByRole('button', { name: 'Release and reserve material' }).click();
  await expect(page.getByRole('heading', { level: 2, name: /WO-000002 · Released/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /Calico/ }).getByRole('cell').nth(1)).toHaveText('210');   // reserved
});

test('the store issues material, the floor runs the steps, and output goes on hold for inspection', async ({ browser }) => {
  const store = await as(browser, 'storeman@e2e.test');
  await go(store, 'Work orders');
  await store.getByRole('button', { name: 'WO-000002' }).click();
  await expect(store.getByRole('button', { name: 'Start Cut' })).toHaveCount(0);   // not an operator
  await store.getByLabel(/^Issue CAL-001/).fill('200');   // part of the calico now, none of the buttons yet
  await store.getByLabel(/^Issue BTN-001/).fill('0');
  await store.getByRole('button', { name: 'Issue material' }).click();
  await expect(store.getByRole('row', { name: /Calico/ }).getByRole('cell').nth(2)).toHaveText('200');   // issued
  await expect(store.getByLabel(/^Issue CAL-001/)).toHaveValue('10');   // defaults to what is still reserved
  await expect(store.getByLabel(/^Issue BTN-001/)).toHaveValue('600');
  await noA11yViolations(store);
  await store.getByRole('button', { name: 'Issue material' }).click();
  await expect(store.getByRole('row', { name: /Calico/ }).getByRole('cell').nth(2)).toHaveText('210');
  await expect(store.getByRole('row', { name: /Button/ }).getByRole('cell').nth(2)).toHaveText('600');

  const op = await as(browser, 'operator@e2e.test');
  await go(op, 'Work orders');
  await op.getByRole('button', { name: 'WO-000002' }).click();
  await expect(op.getByRole('button', { name: 'Issue material' })).toHaveCount(0);   // not the storeman
  await op.getByRole('button', { name: 'Start Sew' }).click();
  await expect(op.getByRole('alert')).toContainText('Earlier operations must be completed first');
  await op.getByRole('button', { name: 'Start Cut' }).click();
  await op.getByLabel('Good quantity, Cut').fill('100');
  await op.getByRole('button', { name: 'Finish Cut' }).click();
  await op.getByRole('button', { name: 'Start Sew' }).click();
  await op.getByLabel('Good quantity, Sew').fill('98');
  await op.getByLabel('Scrap quantity, Sew').fill('2');
  await op.getByRole('button', { name: 'Finish Sew' }).click();
  await expect(op.getByText('Done: 98 good, 2 scrap')).toBeVisible();

  await op.getByLabel('Good quantity made').fill('98');
  await op.getByLabel('Lot / roll code').fill('SH-LOT-1');
  await noA11yViolations(op);
  await op.getByRole('button', { name: 'Record output' }).click();
  await expect(op.getByRole('row', { name: /Shirt/ })).toContainText('SH-LOT-1');
  await expect(op.getByRole('row', { name: /Shirt/ })).toContainText('On hold');
});

test('completing and closing: within tolerance closes straight away', async ({ browser }) => {
  const lead = await as(browser, 'production-lead@e2e.test');
  await go(lead, 'Work orders');
  await lead.getByRole('button', { name: 'WO-000002' }).click();
  await lead.getByRole('button', { name: 'Mark complete' }).click();
  const use = lead.getByRole('region', { name: 'Material use' });
  await expect(use.getByText('Material use is within tolerance.')).toBeVisible();
  // expected for 98 shirts: 2 × 98 × 1.05 = 205.8; 210 issued is 2% over, inside 5%
  await expect(use.getByRole('row', { name: /CAL-001/ })).toContainText('205.8');
  await noA11yViolations(lead);
  await use.getByRole('button', { name: 'Close work order' }).click();
  await expect(lead.getByRole('heading', { level: 2, name: /WO-000002 · Closed/ })).toBeVisible();
});

test('material use far outside tolerance needs a reason before closing', async ({ browser }) => {
  const planner = await as(browser, 'planner@e2e.test');
  await go(planner, 'Work orders');
  await planner.getByText('New work order').click();
  await planner.getByLabel('Quantity to make').fill('10');
  await planner.getByRole('button', { name: 'Create work order' }).click();
  await planner.getByRole('button', { name: 'Release and reserve material' }).click();
  await expect(planner.getByRole('heading', { level: 2, name: /WO-000003 · Released/ })).toBeVisible();

  const lead = await as(browser, 'production-lead@e2e.test');
  await go(lead, 'Work orders');
  await lead.getByRole('button', { name: 'WO-000003' }).click();
  await lead.getByRole('button', { name: 'Issue material' }).click();   // everything reserved: 21 calico, 60 buttons

  const op = await as(browser, 'operator@e2e.test');
  await go(op, 'Work orders');
  await op.getByRole('button', { name: 'WO-000003' }).click();
  await op.getByRole('button', { name: 'Start Cut' }).click();
  await op.getByLabel('Good quantity, Cut').fill('4');
  await op.getByRole('button', { name: 'Finish Cut' }).click();
  await op.getByRole('button', { name: 'Start Sew' }).click();
  await op.getByLabel('Good quantity, Sew').fill('4');
  await op.getByRole('button', { name: 'Finish Sew' }).click();
  await op.getByLabel('Good quantity made').fill('4');
  await op.getByLabel('Lot / roll code').fill('SH-LOT-2');
  await op.getByRole('button', { name: 'Record output' }).click();

  await lead.reload();
  await lead.getByRole('button', { name: 'Mark complete' }).click();
  const use = lead.getByRole('region', { name: 'Material use' });
  await expect(use.getByText('Material use is outside tolerance. Say why before closing.')).toBeVisible();
  await expect(use.getByRole('button', { name: 'Close work order' })).toBeDisabled();
  await use.getByLabel('Reason for the difference').fill('Only four shirts finished before the machine broke');
  await use.getByRole('button', { name: 'Close work order' }).click();
  await expect(lead.getByRole('heading', { level: 2, name: /WO-000003 · Closed/ })).toBeVisible();
  await expect(lead.getByText(/Closed outside tolerance: Only four shirts/)).toBeVisible();
});

test('held output is released by a different person, and a lot can be held again', async ({ browser }) => {
  const inspector = await as(browser, 'inspector@e2e.test');
  await go(inspector, 'Quality holds');
  await expect(inspector.getByRole('row', { name: /SH-LOT-1/ })).toContainText('On hold');
  await noA11yViolations(inspector);
  await inspector.getByRole('button', { name: 'Release SH-LOT-1' }).click();
  await inspector.getByLabel('Inspection note').fill('Passed visual and seam checks');
  await inspector.getByRole('button', { name: 'Release lot' }).click();
  await expect(inspector.getByRole('row', { name: /SH-LOT-1/ })).toContainText('Available');

  await inspector.getByRole('button', { name: 'Hold SH-LOT-1' }).click();
  await inspector.getByLabel('Reason').fill('Customer reported loose buttons');
  await inspector.getByRole('button', { name: 'Put on hold' }).click();
  await expect(inspector.getByRole('row', { name: /SH-LOT-1/ })).toContainText('Customer reported loose buttons');
  await expect(inspector.getByText('You held it')).toBeVisible();
  await expect(inspector.getByRole('button', { name: 'Release SH-LOT-1' })).toHaveCount(0);

  const admin = await as(browser, 'admin@e2e.test');
  await go(admin, 'Quality holds');
  await admin.getByLabel('Only lots on hold').check();
  await admin.getByRole('button', { name: 'Release SH-LOT-1' }).click();
  await admin.getByLabel('Inspection note').fill('Buttons re-sewn and checked');
  await admin.getByRole('button', { name: 'Release lot' }).click();
  await expect(admin.getByRole('row', { name: /SH-LOT-1/ })).toHaveCount(0);
});

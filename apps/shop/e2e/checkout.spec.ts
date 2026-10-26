import { expect, test } from '@playwright/test';
import { admin, completeProfile, signUp, uniqueEmail } from './helpers';

test.describe('buying', () => {
  test('a new shopper builds a basket, checks out by bank transfer and sees the order through payment', async ({ page }) => {
    // basket: Ankara by the metre, then a whole roll (50 m) from the quick button
    await page.goto('/product/ankara-wax-print');
    await page.getByLabel(/Quantity/).fill('3');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await expect(page.getByText('Added to your basket')).toBeVisible();
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Your basket' })).toBeVisible();
    // 3 m x 1,000 + 7.5% tax
    await expect(page.getByLabel('Order summary').getByText('₦3,225.00')).toBeVisible();

    // checkout asks to sign in; the basket survives
    await page.getByRole('link', { name: 'Checkout' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
    const email = await signUp(page, uniqueEmail(), '/checkout');
    await completeProfile(page);

    await expect(page.getByRole('heading', { name: '1. Delivery address' })).toBeVisible();
    await page.getByLabel('Recipient').fill('Amina Yusuf');
    await page.getByLabel('Phone', { exact: true }).fill('+2348012345678');
    await page.getByLabel('Address', { exact: true }).fill('12 Zoo Road');
    await page.getByLabel('City').fill('Kano');
    await page.getByLabel('State').fill('Kano');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText(/Delivery to Kano:/)).toContainText('₦1,500.00');
    await expect(page.getByLabel('Order summary').getByText('₦4,725.00')).toBeVisible();
    await expect(page.getByRole('radio', { name: /Card or online banking/ })).toBeEnabled();

    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/SO-\d{6}\?placed=1/);
    const orderNo = /SO-\d{6}/.exec(page.url())![0];
    await expect(page.getByRole('heading', { name: `Order ${orderNo}` })).toBeVisible();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();
    await expect(page.getByText('0123456789')).toBeVisible();
    await expect(page.getByText('Test Bank')).toBeVisible();
    await expect(page.getByText(/exactly/)).toContainText('₦4,725.00');

    // the basket is empty after ordering
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Your basket is empty' })).toBeVisible();

    // staff confirm the transfer, prepare and ship; the shopper sees each step
    const orders = await admin('GET', `/v1/sales-orders?q=${encodeURIComponent(email)}`);
    const id = orders.items.find((o: any) => o.orderNo === orderNo).id;
    await admin('POST', `/v1/sales-orders/${id}/payments`, { method: 'bank_transfer', reference: `E2E-${Date.now()}`, amountMinor: 472500 });
    await page.goto(`/orders/${orderNo}`);
    await expect(page.getByText('Paid').first()).toBeVisible();
    await expect(page.getByText('Pay by bank transfer')).toHaveCount(0);
    await admin('POST', `/v1/sales-orders/${id}/steps`, { action: 'ship', carrier: 'GIG Logistics', trackingRef: 'GIG42' });
    await page.reload();
    await expect(page.getByText('On its way').first()).toBeVisible();
    await expect(page.getByText(/GIG Logistics GIG42/)).toBeVisible();

    // the orders list and the account pages
    await page.goto('/account/orders');
    await expect(page.getByRole('link', { name: orderNo })).toBeVisible();
    await page.goto('/account/addresses');
    await expect(page.getByText('12 Zoo Road')).toBeVisible();
  });

  test('stock that is not there stops the checkout, and a shopper can cancel an unpaid order', async ({ page }) => {
    await signUp(page, uniqueEmail('cancel'), '/account');
    await completeProfile(page, 'Bala Musa', '+2348099999999');

    await page.goto('/product/swiss-lace');
    await page.getByLabel(/Quantity/).fill('3');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    // someone else takes it first
    await admin('POST', '/v1/inventory/issues', { locationId: (await admin('GET', '/v1/locations')).find((l: any) => l.name === 'Kano Warehouse').id, reasonCode: 'sample', lines: [{ variantId: (await admin('GET', '/v1/products?limit=200')).find((p: any) => p.name === 'Swiss Lace').variants[0].id, quantity: '2' }] });
    await page.goto('/cart');
    await expect(page.getByText(/Only 1 m left/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Checkout' })).toBeDisabled();
    await page.getByLabel(/Qty/).fill('1');
    await page.getByLabel(/Qty/).blur();
    await expect(page.getByRole('link', { name: 'Checkout' })).toBeVisible();
    await page.getByRole('link', { name: 'Checkout' }).click();

    await page.getByLabel('Recipient').fill('Bala Musa');
    await page.getByLabel('Phone', { exact: true }).fill('+2348099999999');
    await page.getByLabel('Address', { exact: true }).fill('5 Lagos Street');
    await page.getByLabel('City').fill('Ikeja');
    await page.getByLabel('State').fill('Lagos');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText(/Delivery to Lagos:/)).toContainText('₦4,500.00');
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/SO-/);
    page.once('dialog', (d) => d.accept());
    await page.getByRole('button', { name: 'Cancel this order' }).click();
    await expect(page.getByText('Cancelled').first()).toBeVisible();
  });

  test('sign-up tells the shopper to confirm their email when the project requires it', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /new here/i }).click();
    await page.getByLabel('Email').fill(uniqueEmail('confirm'));
    await page.getByLabel('Password').fill('correct-horse-battery');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText(/confirmation link/)).toBeVisible();
    await page.getByLabel('Email').fill('taken@e2e.test');
    await page.getByRole('button', { name: 'Create account' }).click();
    await expect(page.getByText(/already exists/)).toBeVisible();
  });

  test('wishlist needs sign-in, then remembers hearts', async ({ page }) => {
    await page.goto('/product/atampa-blue');
    await page.getByRole('button', { name: 'Save to wishlist' }).click();
    await expect(page).toHaveURL(/\/login/);
    await signUp(page, uniqueEmail('wish'), '/account');
    await completeProfile(page);
    await page.goto('/product/atampa-blue');
    await page.getByRole('button', { name: 'Save to wishlist' }).click();
    await expect(page.getByRole('button', { name: 'Remove from wishlist' })).toBeVisible();
    await page.goto('/account/wishlist');
    await expect(page.locator('article', { hasText: 'Atampa Blue' })).toBeVisible();
  });
});

test.describe('paying by card', () => {
  test('goes to the payment page, returns, and the server confirms the payment', async ({ page }) => {
    await signUp(page, uniqueEmail('card'), '/account');
    await completeProfile(page, 'Chidi Obi', '+2348077777777');
    await page.goto('/product/atampa-blue');
    await page.getByLabel(/Quantity/).fill('10');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await page.goto('/checkout');
    await page.getByLabel('Recipient').fill('Chidi Obi');
    await page.getByLabel('Phone', { exact: true }).fill('+2348077777777');
    await page.getByLabel('Address', { exact: true }).fill('3 Market Road');
    await page.getByLabel('City').fill('Kano');
    await page.getByLabel('State').fill('Kano');
    await page.getByRole('button', { name: 'Save address' }).click();
    await page.getByRole('radio', { name: /Card or online banking/ }).check();
    // 10 m x 1,800 + 7.5% = 19,350 + 1,500 delivery
    await expect(page.getByLabel('Order summary').getByText('₦20,850.00')).toBeVisible();
    await page.getByRole('button', { name: 'Place order' }).click();

    // the order page sends the shopper on to the provider; they abandon first
    await page.waitForURL(/localhost:3400\/pay\//);
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/orders\/SO-\d{6}\?paid=1&reference=/);
    await expect(page.getByText(/did not go through/)).toBeVisible();
    await expect(page.getByText('Awaiting payment').first()).toBeVisible();

    // try again and complete it
    await page.getByRole('button', { name: 'Pay now' }).click();
    await page.waitForURL(/localhost:3400\/pay\//);
    await page.getByRole('link', { name: 'Pay', exact: true }).click();
    await expect(page).toHaveURL(/\/orders\/SO-\d{6}\?paid=1&reference=/);
    await expect(page.getByText('Paid').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pay now' })).toHaveCount(0);
  });
});

test.describe('coupons', () => {
  test('a valid code is priced by the server, a bad one is explained, and a used one cannot be used twice', async ({ page }) => {
    await signUp(page, uniqueEmail('coupon'), '/account');
    await completeProfile(page, 'Kemi Ade', '+2348066666666');
    await page.goto('/product/atampa-blue');
    await page.getByLabel(/Quantity/).fill('2');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await page.goto('/cart');
    const summary = page.getByLabel('Order summary');
    await expect(summary.getByText('₦3,870.00')).toBeVisible(); // 2 x 1,800 + 7.5%

    await summary.getByLabel('Coupon code').fill('nonsense');
    await summary.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('That coupon code is not valid')).toBeVisible();
    await expect(summary.getByText('₦3,870.00')).toBeVisible();

    await summary.getByLabel('Coupon code').fill('welcome10');
    await summary.getByRole('button', { name: 'Apply' }).click();
    await expect(summary.getByText(/Coupon WELCOME10 \(10% off\)/)).toBeVisible();
    await expect(summary.getByText('₦3,483.00')).toBeVisible(); // 3,600 - 10% = 3,240 + 7.5%

    await page.getByRole('link', { name: 'Checkout' }).click();
    await page.getByLabel('Recipient').fill('Kemi Ade');
    await page.getByLabel('Phone', { exact: true }).fill('+2348066666666');
    await page.getByLabel('Address', { exact: true }).fill('9 Ahmadu Bello Way');
    await page.getByLabel('City').fill('Kano');
    await page.getByLabel('State').fill('Kano');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByLabel('Order summary').getByText('₦4,983.00')).toBeVisible(); // + 1,500 delivery
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/SO-/);
    await expect(page.getByText(/Coupon WELCOME10/)).toBeVisible();
    await expect(page.getByText(/saved/)).toBeVisible();

    // the same shopper cannot use it again
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Your basket is empty' })).toBeVisible();
    await page.goto('/product/atampa-blue');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await page.goto('/cart');
    await page.getByLabel('Coupon code').fill('WELCOME10');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText(/already used that coupon/)).toBeVisible();
  });
});

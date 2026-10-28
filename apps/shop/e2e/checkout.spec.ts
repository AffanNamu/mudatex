import AxeBuilder from '@axe-core/playwright';
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

    // the unpaid invoice shows what is owed and where to pay it
    await page.getByRole('link', { name: 'Invoice / receipt' }).click();
    const invoice = page.getByRole('article', { name: new RegExp(`Invoice ${orderNo}`) });
    await expect(invoice.getByRole('heading', { name: 'Invoice' })).toBeVisible();
    await expect(invoice.getByText('Balance to pay: ₦4,725.00')).toBeVisible();
    await expect(invoice.getByText(/Test Bank/)).toBeVisible();
    await expect(invoice.getByText('Amina Yusuf').first()).toBeVisible();
    await expect(invoice.getByText('VAT75 (7.5%)')).toBeVisible();
    await expect(invoice.getByText('Tax number: TIN-445566')).toBeVisible();
    await expect(invoice.getByText('Goods once sold are exchanged within 7 days.')).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);

    // the basket is empty after ordering
    await page.goto('/cart');
    await expect(page.getByRole('heading', { name: 'Your basket is empty' })).toBeVisible();

    // staff confirm the transfer, prepare and ship; the shopper sees each step
    const orders = await admin('GET', `/v1/sales-orders?q=${encodeURIComponent(email)}`);
    const id = orders.items.find((o: any) => o.orderNo === orderNo).id;
    await admin('POST', `/v1/sales-orders/${id}/payments`, { method: 'bank_transfer', reference: `E2E-${Date.now()}`, amountMinor: 472500 });
    await page.goto(`/orders/${orderNo}/invoice`);
    await expect(page.getByRole('heading', { name: 'Receipt' })).toBeVisible();
    await expect(page.getByText('Paid in full. Thank you.')).toBeVisible();
    await expect(page.getByText('Balance to pay')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByRole('button', { name: 'Print or save as PDF' })).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Receipt' })).toBeVisible();
    await page.emulateMedia({ media: 'screen' });
    await page.goto(`/orders/${orderNo}`);
    await expect(page.getByText('Paid').first()).toBeVisible();
    await expect(page.getByText('Pay by bank transfer')).toHaveCount(0);
    const carrier = await admin('POST', '/v1/carriers', { key: `gig-${Date.now().toString(36)}`, name: 'GIG Logistics', kind: 'manual', trackingUrl: 'https://gig.example/track?no={ref}' });
    await admin('POST', `/v1/sales-orders/${id}/steps`, { action: 'ship', carrierId: carrier.id, trackingRef: 'GIG42' });
    await page.reload();
    await expect(page.getByText('On its way').first()).toBeVisible();
    const parcel = page.getByRole('region', { name: 'Your parcel' });
    await expect(parcel.getByText('Handed to the delivery company')).toBeVisible();
    await expect(parcel.getByText('Delivery company: GIG Logistics')).toBeVisible();
    await expect(parcel.getByText('Tracking number: GIG42')).toBeVisible();
    await expect(parcel.getByRole('link', { name: /Track on GIG Logistics/ })).toHaveAttribute('href', 'https://gig.example/track?no=GIG42');
    await expect(parcel.getByText('No updates from the delivery company yet.')).toBeVisible();
    await admin('POST', `/v1/sales-orders/${id}/shipment/events`, { status: 'out_for_delivery', description: 'With the rider', location: 'Kano' });
    await page.reload();
    await expect(parcel.getByText('Out for delivery').first()).toBeVisible();
    await expect(parcel.getByText(/With the rider/)).toBeVisible();
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations).toEqual([]);

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

test.describe('reviews', () => {
  test('a shopper whose order shipped reviews it, and it shows after approval', async ({ page }) => {
    const email = uniqueEmail('review');
    await signUp(page, email, '/account');
    await completeProfile(page, 'Ibrahim Danladi Sani', '+2348012121212');
    // before buying, the form explains itself
    await page.goto('/product/atampa-blue');
    await page.getByLabel('Your review').fill('Beautiful fabric, very good quality indeed.');
    await page.getByRole('button', { name: 'Submit review' }).click();
    await expect(page.locator('p.err')).toContainText('once it has been delivered');

    await page.getByLabel(/Quantity/).fill('2');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await page.goto('/checkout');
    await page.getByLabel('Recipient').fill('Ibrahim Sani');
    await page.getByLabel('Phone', { exact: true }).fill('+2348012121212');
    await page.getByLabel('Address', { exact: true }).fill('4 Bompai Road');
    await page.getByLabel('City').fill('Kano');
    await page.getByLabel('State').fill('Kano');
    await page.getByRole('button', { name: 'Save address' }).click();
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/SO-/);
    const orderNo = /SO-\d{6}/.exec(page.url())![0];
    const orders = await admin('GET', `/v1/sales-orders?q=${encodeURIComponent(orderNo)}`);
    const o = orders.items[0];
    await admin('POST', `/v1/sales-orders/${o.id}/payments`, { method: 'bank_transfer', reference: `REV-${Date.now()}`, amountMinor: o.totalMinor });
    await admin('POST', `/v1/sales-orders/${o.id}/steps`, { action: 'ship' });

    await page.goto('/product/atampa-blue');
    await expect(page.getByText('No reviews yet.')).toBeVisible();
    await page.getByRole('button', { name: '4 stars' }).click();
    await page.getByLabel('Headline (optional)').fill('Good value');
    await page.getByLabel('Your review').fill('Beautiful fabric, very good quality indeed.');
    await page.getByRole('button', { name: 'Submit review' }).click();
    await expect(page.getByText(/appear once our team has read it/)).toBeVisible();

    const queue = await admin('GET', '/v1/reviews');
    const mine = queue.find((q: any) => q.name === 'Ibrahim S.');
    expect(mine).toMatchObject({ rating: 4, title: 'Good value' });
    await admin('POST', `/v1/reviews/${mine.id}/moderate`, { status: 'published' });
    await page.waitForTimeout(100);
    // the product page is cached for up to a minute; the API shows it at once
    const api = await (await fetch('http://localhost:3100/shop/e2e-shop/products/atampa-blue/reviews')).json();
    expect(api.items[0]).toMatchObject({ rating: 4, name: 'Ibrahim S.' });
  });
});

test.describe('trade accounts', () => {
  test('a business applies, is approved with credit, sees trade prices and orders on account', async ({ page }) => {
    const email = uniqueEmail('trade');
    await signUp(page, email, '/account');
    await completeProfile(page, 'Hajiya Zainab', '+2348030000001');
    await page.goto('/trade');
    await page.getByLabel('Business name').fill('Zainab Fabrics');
    await page.getByRole('button', { name: 'Send application' }).click();
    await expect(page.getByText(/application received/)).toBeVisible();

    // staff approve it with the wholesale list and a credit limit
    const queue = await admin('GET', '/v1/trade-accounts?status=pending');
    const mine = queue.find((t: any) => t.email === email);
    const lists = await admin('GET', '/v1/pricing/price-lists');
    await admin('POST', `/v1/trade-accounts/${mine.id}/decision`, { status: 'approved', priceListId: lists.find((l: any) => l.name === 'Wholesale NGN').id, creditLimitMinor: 5_000_000, paymentTermsDays: 30 });

    await page.goto('/trade');
    await expect(page.getByText('approved.', { exact: false })).toBeVisible();
    await expect(page.getByText('₦50,000.00').first()).toBeVisible();

    await page.goto('/product/atampa-blue');
    await page.getByLabel(/Quantity/).fill('10');
    await page.getByRole('button', { name: 'Add to basket' }).click();
    await page.goto('/cart');
    await expect(page.getByText('Trade prices applied.')).toBeVisible();
    await expect(page.getByLabel('Order summary').getByText('₦16,125.00')).toBeVisible(); // 10 x 1,500 + 7.5%

    await page.getByRole('link', { name: 'Checkout' }).click();
    await page.getByLabel('Recipient').fill('Zainab');
    await page.getByLabel('Phone', { exact: true }).fill('+2348030000001');
    await page.getByLabel('Address', { exact: true }).fill('Kwari Market, Shop 12');
    await page.getByLabel('City').fill('Kano');
    await page.getByLabel('State').fill('Kano');
    await page.getByRole('button', { name: 'Save address' }).click();
    await page.getByRole('radio', { name: /On account/ }).check();
    await page.getByRole('button', { name: 'Place order' }).click();
    await expect(page).toHaveURL(/\/orders\/SO-/);
    await expect(page.getByText(/on your trade account/)).toBeVisible();
    await expect(page.getByText('Confirmed (on account)').first()).toBeVisible();

    await page.goto('/trade');
    await expect(page.getByRole('cell', { name: /Order SO-/ })).toBeVisible();
    await expect(page.getByText('₦17,625.00').first()).toBeVisible();
  });

  test('a buyer opens a quote staff sent, and accepting it places the order at the agreed prices', async ({ page }) => {
    const email = uniqueEmail('quote');
    await signUp(page, email, '/account');
    await completeProfile(page, 'Hajiya Rabi', '+2348030000002');
    await page.goto('/trade');
    await page.getByLabel('Business name').fill('Rabi Textiles');
    await page.getByRole('button', { name: 'Send application' }).click();
    await expect(page.getByText(/application received/)).toBeVisible();
    const queue = await admin('GET', '/v1/trade-accounts?status=pending');
    const mine = queue.find((t: any) => t.email === email);
    const lists = await admin('GET', '/v1/pricing/price-lists');
    await admin('POST', `/v1/trade-accounts/${mine.id}/decision`, { status: 'approved', priceListId: lists.find((l: any) => l.name === 'Wholesale NGN').id, creditLimitMinor: 5_000_000, paymentTermsDays: 30 });

    // staff agree 1,400 a metre (below the 1,500 trade price) for ten metres and send the quote
    const products = await admin('GET', '/v1/products?limit=200');
    const atampa = products.find((p: any) => p.variants.some((v: any) => v.sku === 'ATP-001')).variants.find((v: any) => v.sku === 'ATP-001');
    const until = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const quote = await admin('POST', '/v1/quotes', { tradeAccountId: mine.id, validUntil: until, note: 'Eid rush price', lines: [{ variantId: atampa.id, quantity: '10', unitPrice: '1400' }] });
    await admin('POST', `/v1/quotes/${quote.id}/send`, {});

    await page.goto('/trade');
    await page.getByRole('link', { name: quote.quoteNo }).click();
    await expect(page.getByRole('heading', { name: `Quote ${quote.quoteNo}` })).toBeVisible();
    await expect(page.getByText('Eid rush price')).toBeVisible();
    await expect(page.getByText('₦15,050.00').first()).toBeVisible();   // 10 × 1,400 + 7.5%
    await expect(page.getByText('Save a delivery address first.')).toBeVisible();

    await page.goto('/account/addresses');
    await page.getByLabel('Recipient').fill('Rabi');
    await page.getByLabel('Phone', { exact: true }).fill('+2348030000002');
    await page.getByLabel('Address', { exact: true }).fill('Sabon Gari Market');
    await page.getByLabel('City').fill('Kano');
    await page.getByLabel('State').fill('Kano');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByText('Sabon Gari Market')).toBeVisible();

    await page.goto(`/quotes/${quote.quoteNo}`);
    await page.getByRole('radio', { name: /On account/ }).check();
    await page.getByRole('button', { name: 'Accept and place the order' }).click();
    await expect(page).toHaveURL(/\/orders\/SO-/);
    await expect(page.getByText('₦16,550.00').first()).toBeVisible();   // goods 15,050.00 + 1,500.00 delivery
    await expect(page.getByText(/on your trade account/)).toBeVisible();

    // The same goods again every two weeks: set up from the order, then paused, resumed and cancelled.
    await page.getByLabel('How often').selectOption('fortnightly');
    await page.getByRole('button', { name: 'Set up the standing order' }).click();
    await expect(page.getByText(/Your next order will be placed on/)).toBeVisible();
    await page.getByRole('link', { name: 'Manage standing orders' }).click();
    const standing = page.locator('li.card', { hasText: 'every two weeks' });
    await expect(standing).toContainText('Active');
    await expect(standing).toContainText('Atampa Blue × 10');
    await standing.getByRole('button', { name: 'Pause' }).click();
    await expect(standing).toContainText('Paused');
    await standing.getByRole('button', { name: 'Resume' }).click();
    await expect(standing).toContainText('Active');
    page.once('dialog', (d) => d.accept());
    await standing.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText(/No standing orders yet/)).toBeVisible();

    await page.goto(`/quotes/${quote.quoteNo}`);
    await expect(page.getByText(/This quote is accepted/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept and place the order' })).toHaveCount(0);
  });
});

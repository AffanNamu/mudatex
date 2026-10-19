import type { SourceData } from '../../src/migration/sakash/source.js';

/** Sentinels that must never reach Mudatex: every one of these strings is personal data in the synthetic export. */
export const PII = ['amina.bello@example.com', '+2348012345678', '12 Ahmadu Bello Way, Kaduna', 'Chinedu Okafor', 'uid-customer-77', 'cashier.zainab@example.com', 'fcm-token-abc123', 'Musa Danjuma'];

const t = (day: number) => `2025-03-${String(day).padStart(2, '0')}T09:30:00.000Z`;

export function syntheticSakash(opts: { products?: number; sales?: number } = {}): { data: SourceData; present: string[] } {
  const good = Array.from({ length: opts.products ?? 25 }, (_, i) => ({
    id: `prod${String(i).padStart(4, '0')}`,
    name: `Ankara Wax Print ${i}`,
    description: `Cotton wax print, design ${i}`,
    price: 2500 + i * 50 + (i % 3 === 0 ? 0.5 : 0),
    stockQuantity: 10 + i,
    category: i % 2 ? 'Ankara' : 'Lace',
    categories: ['Fabrics', i % 2 ? 'Ankara' : 'Lace'],
    fabricType: 'Cotton', material: '100% cotton', availableColors: ['Red', 'Blue'], availableSizes: ['6 yards'], yardage: 6, gsm: '120',
    createdAt: t(1 + (i % 28)), createdBy: 'uid-admin-1', imageUrl: `https://img.example/${i}.jpg`, promoDiscountPercent: i % 5 === 0 ? 15 : 0, promoText: i % 5 === 0 ? 'Sale' : '',
    soldCount: i, rating: 4.5, reviewCount: 3, isBestSeller: i % 7 === 0,
  }));
  const messy = [
    { id: 'bad-noname', name: '   ', price: 100, stockQuantity: 5 },
    { id: 'bad-price', name: 'Broken price', price: 'abc', stockQuantity: 5 },
    { id: 'bad-price-huge', name: 'Absurd price', price: 1e13, stockQuantity: 1 },
    { id: 'warn-negative', name: 'Negative stock', price: 1200, stockQuantity: -4 },
    { id: 'warn-fraction', name: 'Fractional stock', price: 1300, stockQuantity: 2.5 },
    { id: 'ok-stringstock', name: 'String stock', price: '1500', stockQuantity: '7' },
    { id: 'ok-flagged', name: 'Flagged out', price: 900, stockQuantity: 3, inStock: false },
    { id: 'ok-zero', name: 'Free sample', price: 0, stockQuantity: 0 },
    { id: 'ok-unicode', name: 'Aso-oke · ọ̀gbà', price: 8000, stockQuantity: 2 },
    { id: 'prod0003', name: 'Duplicate of an earlier id', price: 1, stockQuantity: 1 },
    { name: 'No id at all', price: 100, stockQuantity: 1 },
  ];
  const n = opts.sales ?? 12;
  const posSales = Array.from({ length: n }, (_, i) => ({
    id: `sale${String(i).padStart(4, '0')}`, receiptId: `PFB-20250301-${String(1000 + i)}`, branchId: 'b1', branchName: 'Kaduna', createdAt: i % 2 ? { _seconds: 1741000000 + i * 3600 } : t(2 + (i % 20)),
    status: i % 9 === 8 ? 'voided' : 'completed', items: [{ productId: 'prod0001', name: 'Ankara Wax Print 1', quantity: 2, price: 2550, imageUrl: 'x', internalNote: 'secret' }],
    subtotal: 5100, discountValue: 0, discountType: 'none', discountReason: '', finalTotal: 5100 + i, paymentMethod: i % 3 ? 'cash' : 'bank_transfer', amountTendered: 6000, changeGiven: 900 - i, saleChannel: 'physical_shop',
    // personal data that must be dropped
    customerName: 'Chinedu Okafor', customerPhone: '+2348012345678', cashierUid: 'uid-customer-77', cashierName: 'Musa Danjuma', cashierEmail: 'cashier.zainab@example.com',
  }));
  const orders = Array.from({ length: 8 }, (_, i) => ({
    id: `order${i}`, userId: 'uid-customer-77', items: [{ productId: 'prod0002', name: 'Ankara Wax Print 2', quantity: 1, price: 2600 }], totalAmount: 2600 + 1500, status: ['pending', 'delivered', 'cancelled'][i % 3],
    createdAt: t(5 + i), deliveryAddress: '12 Ahmadu Bello Way, Kaduna', assignedAdminEmail: 'amina.bello@example.com', assignedAdminName: 'Musa Danjuma', deliveryFee: 1500,
    paymentReference: `PSK-${i}`, paymentStatus: 'success', notes: 'Call Chinedu Okafor on arrival', fcmToken: 'fcm-token-abc123',
  }));
  const receipts = [{ id: 'rcp1', receiptId: 'PFB-20250301-1000', saleId: 'sale0000', createdAt: t(2), finalTotal: 5100, items: [], customerPhone: '+2348012345678' }, { id: 'rcp2', receiptId: 'PFB-20250301-1001', saleId: 'sale0001', createdAt: t(3), total: 'n/a' }];
  const payments = [{ id: 'pay1', reference: 'PSK-1', amount: 4100, status: 'success', createdAt: t(6), payerEmail: 'amina.bello@example.com' }];
  const dupSale = { ...posSales[0], finalTotal: 999999 };
  const noIdOrder = { totalAmount: 10, status: 'pending' };
  return {
    data: {
      products: [...good, ...messy],
      categories: [{ id: 'c1', name: 'Ankara' }, { id: 'c2', name: 'Lace' }],
      pos_sales: [...posSales, dupSale],
      orders: [...orders, noIdOrder],
      pos_receipts: receipts,
      payments,
    },
    present: ['admins', 'categories', 'orders', 'payment_attempts', 'payments', 'pos_receipts', 'pos_sales', 'products', 'users', 'app_settings', 'mystery_collection'],
  };
}

/** A small, realistic textile catalogue for trying the system out. Prices are in naira per metre unless noted. */
export interface SampleProduct {
  name: string; sku: string; brand: string; department: 'ankara' | 'lace' | 'brocade' | 'atampa' | 'plain'; price: string; wholesale: string;
  stock: string; description: string; badge?: string; roll?: boolean;
}

export const DEPARTMENTS = [
  { slug: 'ankara', name: 'Ankara & wax prints' },
  { slug: 'lace', name: 'Lace' },
  { slug: 'brocade', name: 'Brocade & damask' },
  { slug: 'atampa', name: 'Atampa' },
  { slug: 'plain', name: 'Plain, voile & kamfala' },
];

export const PRODUCTS: SampleProduct[] = [
  { name: 'Royal Ankara Wax Print', sku: 'ANK-ROY', brand: 'Empire Atampa', department: 'ankara', price: '4200', wholesale: '3600', stock: '400', description: 'Bold, colour-fast wax print. Sold by the metre or by the roll of 50 m.', badge: 'Best seller', roll: true },
  { name: 'Sunburst Ankara Wax Print', sku: 'ANK-SUN', brand: 'Empire Atampa', department: 'ankara', price: '3900', wholesale: '3300', stock: '250', description: 'Warm sunburst pattern on a heavy cotton base.', roll: true },
  { name: 'Swiss Voile Lace, Ivory', sku: 'LCE-IVO', brand: 'Florance', department: 'lace', price: '9500', wholesale: '8200', stock: '120', description: 'Soft Swiss voile lace with fine embroidery. Ideal for weddings and celebrations.', badge: 'New' },
  { name: 'Cord Lace, Gold', sku: 'LCE-GLD', brand: 'Florance', department: 'lace', price: '12500', wholesale: '10800', stock: '80', description: 'Rich cord lace with a gold finish.' },
  { name: 'French Net Lace, Wine', sku: 'LCE-WIN', brand: 'Flora', department: 'lace', price: '7800', wholesale: '6700', stock: '60', description: 'Light net lace in deep wine.' },
  { name: 'Jacquard Brocade, Emerald', sku: 'BRC-EME', brand: 'Super Conclusive', department: 'brocade', price: '6800', wholesale: '5900', stock: '150', description: 'Heavy jacquard brocade with a rich sheen.' },
  { name: 'Damask Brocade, Silver', sku: 'BRC-SLV', brand: 'Super Conclusive', department: 'brocade', price: '7200', wholesale: '6200', stock: '90', description: 'Classic damask weave in silver.' },
  { name: 'Atampa, Midnight Blue', sku: 'ATP-MID', brand: 'Empire Atampa', department: 'atampa', price: '5400', wholesale: '4700', stock: '300', description: 'Traditional atampa in deep midnight blue.', badge: 'Best seller' },
  { name: 'Atampa, Crimson', sku: 'ATP-CRI', brand: 'Empire Atampa', department: 'atampa', price: '5400', wholesale: '4700', stock: '220', description: 'Traditional atampa in crimson.' },
  { name: 'Egyptian Kamfala, White', sku: 'KAM-WHT', brand: 'Egyptian Kamfala', department: 'plain', price: '2900', wholesale: '2450', stock: '500', description: 'Crisp white kamfala for caps and gowns.' },
  { name: 'Cotton Voile, Sky', sku: 'VOI-SKY', brand: 'Ismile', department: 'plain', price: '2100', wholesale: '1800', stock: '350', description: 'Light cotton voile in sky blue.' },
  { name: 'Java Print, Garden', sku: 'JAV-GAR', brand: 'Mudatex Java', department: 'ankara', price: '3200', wholesale: '2750', stock: '0', description: 'Floral Java print. Currently sold out, to show how the shop handles it.' },
];

/** French and Hausa wording for the sample store, so the language picker has something to show. */
export const TAGLINE_WORDS = { fr: 'Livraison gratuite dès 100 000 ₦ — boutique d’exemple', ha: 'Isarwa kyauta idan ya wuce ₦100,000 — shagon misali' };
export const DEPARTMENT_WORDS: Record<string, { fr: string; ha: string }> = {
  ankara: { fr: 'Ankara et wax', ha: 'Ankara da wax' },
  lace: { fr: 'Dentelle', ha: 'Leshi' },
  brocade: { fr: 'Brocart et damassé', ha: 'Brocade da damask' },
  atampa: { fr: 'Atampa', ha: 'Atampa' },
  plain: { fr: 'Uni, voile et kamfala', ha: 'Yadi mai sauƙi, voile da kamfala' },
};
export const PRODUCT_TITLES_FR: Record<string, string> = {
  'ANK-ROY': 'Wax Ankara Royal', 'ANK-SUN': 'Wax Ankara Soleil', 'LCE-IVO': 'Dentelle suisse voile, ivoire', 'LCE-GLD': 'Dentelle cordonnet, or',
  'LCE-WIN': 'Dentelle tulle français, bordeaux', 'BRC-EME': 'Brocart jacquard, émeraude', 'BRC-SLV': 'Brocart damassé, argent', 'ATP-MID': 'Atampa, bleu nuit',
  'ATP-CRI': 'Atampa, cramoisi', 'KAM-WHT': 'Kamfala égyptien, blanc', 'VOI-SKY': 'Voile de coton, ciel', 'JAV-GAR': 'Imprimé Java, jardin',
};

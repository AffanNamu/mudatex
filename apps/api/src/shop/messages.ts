import type { ShopLanguage } from './translations.js';

/**
 * What the shop tells a shopper when something is refused, in their language. The English text is also what the error
 * itself carries, so staff screens and logs are unchanged; only answers to the public shop and shopper routes are translated.
 */
const en = {
  'err.coupon.invalid': 'That coupon code is not valid',
  'err.coupon.notActive': 'That coupon is not active yet',
  'err.coupon.expired': 'That coupon has expired',
  'err.coupon.minimum': 'Your basket is below the minimum for this coupon',
  'err.coupon.used': 'That coupon has been fully used',
  'err.coupon.mine': 'You have already used that coupon',
  'err.basket.gone': 'An item in your basket is no longer available',
  'err.basket.duplicate': 'Each product variant can appear once',
  'err.order.duplicate': 'Each product variant can appear on an order once; adjust its quantity instead',
  'err.order.noValue': 'This order has no value',
  'err.address.choose': 'Choose one of your saved delivery addresses',
  'err.address.max': 'You can save up to {n} addresses',
  'err.trade.none': 'Your business does not have an approved trade account',
  'err.trade.exists': 'You already have a trade application or account',
  'err.credit': 'This order would take you over your credit limit (available: {available} minor units)',
  'err.order.cancel': 'An order that is {status} can no longer be cancelled',
  'err.order.cancelContact': 'An order that is {status} can no longer be cancelled here; contact the store',
  'err.delivery.none': 'We do not deliver to that location yet',
  'err.card.notSetUp': 'Card payments are not set up for this store yet',
  'err.card.notWaiting': 'This order is not waiting for payment',
  'err.card.bankOrder': 'This order was placed for bank transfer',
  'err.account.blocked': 'This account is blocked',
  'err.account.noEmail': 'Your sign-in has no email address',
  'err.account.exists': 'An account with this email already exists',
  'err.wishlist.full': 'Your wishlist is full',
  'err.idempotency': 'Idempotency-Key header (8-128 characters) is required',
  'err.pay.unavailable': 'Card payments are not available right now',
  'err.pay.unreachable': 'The payment service could not be reached. Please try again.',
  'err.pay.failed': 'The payment service could not process this request.',
  'err.pay.unexpected': 'The payment service gave an unexpected answer.',
  'err.review.afterDelivery': 'You can review a product once it has been delivered to you',
  'err.review.already': 'You have already reviewed this product',
  'err.quote.closed': 'This quote is no longer open',
  'err.quote.expired': 'This quote has expired',
  'err.quote.hold': 'Your trade account is on hold, so this quote cannot be accepted',
  'err.quote.coupon': 'A coupon cannot be used on a quoted order',
  'err.notFound.Quote': 'Quote not found',
  'err.notFound.Order': 'Order not found',
  'err.notFound.Product': 'Product not found',
  'err.notFound.Store': 'Store not found',
  'err.notFound.Address': 'Address not found',
  'err.notFound.Payment': 'Payment not found',
  'err.notFound.Customer': 'Customer not found',
  'err.notFound.Trade account': 'Trade account not found',
  'err.enquiry.contact': 'Give an email address or a phone number so we can reply',
  'err.unauthorized': 'Authentication required',
  'err.rate': 'Too many requests',
  'err.badRequest': 'Bad request',
  'err.large': 'Request body too large',
  'err.invalidRequest': 'Invalid request',
  'err.internal': 'Internal server error',
  'err.status.pending_payment': 'awaiting payment',
  'err.status.confirmed': 'confirmed',
  'err.status.paid': 'paid',
  'err.status.processing': 'being prepared',
  'err.status.shipped': 'on its way',
  'err.status.delivered': 'delivered',
  'err.status.cancelled': 'cancelled',
  'err.status.expired': 'expired',
} as const;
export type ShopMessageKey = keyof typeof en;

const fr: Record<ShopMessageKey, string> = {
  'err.coupon.invalid': 'Ce code promo n’est pas valable',
  'err.coupon.notActive': 'Ce code promo n’est pas encore actif',
  'err.coupon.expired': 'Ce code promo a expiré',
  'err.coupon.minimum': 'Votre panier n’atteint pas le minimum requis pour ce code promo',
  'err.coupon.used': 'Ce code promo a été entièrement utilisé',
  'err.coupon.mine': 'Vous avez déjà utilisé ce code promo',
  'err.basket.gone': 'Un article de votre panier n’est plus disponible',
  'err.basket.duplicate': 'Chaque article ne peut apparaître qu’une fois',
  'err.order.duplicate': 'Chaque article ne peut figurer qu’une fois dans une commande ; modifiez plutôt sa quantité',
  'err.order.noValue': 'Cette commande n’a aucune valeur',
  'err.address.choose': 'Choisissez l’une de vos adresses de livraison enregistrées',
  'err.address.max': 'Vous pouvez enregistrer jusqu’à {n} adresses',
  'err.trade.none': 'Votre entreprise n’a pas de compte professionnel approuvé',
  'err.trade.exists': 'Vous avez déjà une demande ou un compte professionnel',
  'err.credit': 'Cette commande dépasserait votre plafond de crédit (disponible : {available} unités mineures)',
  'err.order.cancel': 'Une commande {status} ne peut plus être annulée',
  'err.order.cancelContact': 'Une commande {status} ne peut plus être annulée ici ; contactez la boutique',
  'err.delivery.none': 'Nous ne livrons pas encore à cet endroit',
  'err.card.notSetUp': 'Le paiement par carte n’est pas encore configuré pour cette boutique',
  'err.card.notWaiting': 'Cette commande n’attend pas de paiement',
  'err.card.bankOrder': 'Cette commande a été passée pour un virement bancaire',
  'err.account.blocked': 'Ce compte est bloqué',
  'err.account.noEmail': 'Votre connexion n’a pas d’adresse e-mail',
  'err.account.exists': 'Un compte existe déjà avec cet e-mail',
  'err.wishlist.full': 'Votre liste de favoris est pleine',
  'err.idempotency': 'L’en-tête Idempotency-Key (8 à 128 caractères) est requis',
  'err.pay.unavailable': 'Le paiement par carte n’est pas disponible pour le moment',
  'err.pay.unreachable': 'Le service de paiement est injoignable. Veuillez réessayer.',
  'err.pay.failed': 'Le service de paiement n’a pas pu traiter cette demande.',
  'err.pay.unexpected': 'Le service de paiement a donné une réponse inattendue.',
  'err.review.afterDelivery': 'Vous pourrez donner votre avis sur un produit une fois qu’il vous aura été livré',
  'err.review.already': 'Vous avez déjà donné votre avis sur ce produit',
  'err.quote.closed': 'Ce devis n’est plus ouvert',
  'err.quote.expired': 'Ce devis a expiré',
  'err.quote.hold': 'Votre compte professionnel est suspendu : ce devis ne peut pas être accepté',
  'err.quote.coupon': 'Un code promo ne peut pas être utilisé sur une commande issue d’un devis',
  'err.notFound.Quote': 'Devis introuvable',
  'err.notFound.Order': 'Commande introuvable',
  'err.notFound.Product': 'Produit introuvable',
  'err.notFound.Store': 'Boutique introuvable',
  'err.notFound.Address': 'Adresse introuvable',
  'err.notFound.Payment': 'Paiement introuvable',
  'err.notFound.Customer': 'Client introuvable',
  'err.notFound.Trade account': 'Compte professionnel introuvable',
  'err.enquiry.contact': 'Indiquez une adresse e-mail ou un numéro de téléphone pour que nous puissions vous répondre',
  'err.unauthorized': 'Authentification requise',
  'err.rate': 'Trop de requêtes',
  'err.badRequest': 'Requête incorrecte',
  'err.large': 'Requête trop volumineuse',
  'err.invalidRequest': 'Requête invalide',
  'err.internal': 'Erreur interne du serveur',
  'err.status.pending_payment': 'en attente de paiement',
  'err.status.confirmed': 'confirmée',
  'err.status.paid': 'payée',
  'err.status.processing': 'en préparation',
  'err.status.shipped': 'en route',
  'err.status.delivered': 'livrée',
  'err.status.cancelled': 'annulée',
  'err.status.expired': 'expirée',
};

// First draft; a Hausa speaker should read it before launch (see docs/operations/SHOP_LANGUAGES.md).
const ha: Record<ShopMessageKey, string> = {
  'err.coupon.invalid': 'Wannan lambar kuponi ba ta da inganci',
  'err.coupon.notActive': 'Wannan kuponi bai fara aiki ba tukuna',
  'err.coupon.expired': 'Lokacin wannan kuponi ya ƙure',
  'err.coupon.minimum': 'Kwandonku bai kai mafi ƙarancin adadin da wannan kuponi yake buƙata ba',
  'err.coupon.used': 'An yi amfani da wannan kuponi gaba ɗaya',
  'err.coupon.mine': 'Kun riga kun yi amfani da wannan kuponi',
  'err.basket.gone': 'Wani kaya a kwandonku ba ya nan yanzu',
  'err.basket.duplicate': 'Kowane kaya zai bayyana sau ɗaya kawai',
  'err.order.duplicate': 'Kowane kaya zai bayyana sau ɗaya kawai a cikin oda; ku canza adadinsa maimakon haka',
  'err.order.noValue': 'Wannan oda ba shi da daraja',
  'err.address.choose': 'Ku zaɓi ɗaya daga cikin adiresoshin isarwa da kuka ajiye',
  'err.address.max': 'Kuna iya ajiye adireshi har {n}',
  'err.trade.none': 'Kasuwancinku ba shi da asusun ɗan kasuwa da aka amince da shi',
  'err.trade.exists': 'Kun riga kuna da buƙata ko asusun ɗan kasuwa',
  'err.credit': 'Wannan oda zai wuce iyakar bashinku (abin da ya rage: {available} ƙananan raka’a)',
  'err.order.cancel': 'Oda da yake {status} ba za a iya soke shi ba',
  'err.order.cancelContact': 'Oda da yake {status} ba za a iya soke shi a nan ba; ku tuntuɓi shagon',
  'err.delivery.none': 'Ba mu isar da kaya zuwa wannan wuri ba tukuna',
  'err.card.notSetUp': 'Ba a saita biya da kati a wannan shagon ba tukuna',
  'err.card.notWaiting': 'Wannan oda ba ya jiran biya',
  'err.card.bankOrder': 'An yi wannan oda don tura kuɗi ta banki',
  'err.account.blocked': 'An toshe wannan asusu',
  'err.account.noEmail': 'Shigarku ba ta da adireshin imel',
  'err.account.exists': 'Akwai asusu da wannan imel ɗin',
  'err.wishlist.full': 'Jerin abubuwan da kuke so ya cika',
  'err.idempotency': 'Ana buƙatar kan Idempotency-Key (haruffa 8 zuwa 128)',
  'err.pay.unavailable': 'Biya da kati ba ya samuwa a yanzu',
  'err.pay.unreachable': 'Ba a iya isa ga sabis ɗin biya ba. Ku sake gwadawa.',
  'err.pay.failed': 'Sabis ɗin biya bai iya sarrafa wannan buƙata ba.',
  'err.pay.unexpected': 'Sabis ɗin biya ya ba da amsa da ba a tsammata ba.',
  'err.review.afterDelivery': 'Za ku iya yin sharhi game da kaya bayan an isar muku da shi',
  'err.review.already': 'Kun riga kun yi sharhi game da wannan kaya',
  'err.quote.closed': 'Wannan ƙiyasin farashi ya daina buɗewa',
  'err.quote.expired': 'Lokacin wannan ƙiyasin farashi ya ƙure',
  'err.quote.hold': 'An dakatar da asusun ɗan kasuwanku, don haka ba za a iya karɓar wannan ƙiyasin farashi ba',
  'err.quote.coupon': 'Ba za a iya amfani da kuponi a kan odar da ta fito daga ƙiyasin farashi ba',
  'err.notFound.Quote': 'Ba a sami ƙiyasin farashi ba',
  'err.notFound.Order': 'Ba a sami oda ba',
  'err.notFound.Product': 'Ba a sami kaya ba',
  'err.notFound.Store': 'Ba a sami shago ba',
  'err.notFound.Address': 'Ba a sami adireshi ba',
  'err.notFound.Payment': 'Ba a sami biya ba',
  'err.notFound.Customer': 'Ba a sami abokin ciniki ba',
  'err.notFound.Trade account': 'Ba a sami asusun ɗan kasuwa ba',
  'err.enquiry.contact': 'Ku bayar da adireshin imel ko lambar waya don mu iya amsa muku',
  'err.unauthorized': 'Ana buƙatar shiga',
  'err.rate': 'Buƙatu sun yi yawa',
  'err.badRequest': 'Buƙata mara kyau',
  'err.large': 'Buƙatar ta yi girma da yawa',
  'err.invalidRequest': 'Buƙata mara inganci',
  'err.internal': 'Matsala a cikin sabar',
  'err.status.pending_payment': 'ana jiran biya',
  'err.status.confirmed': 'an tabbatar',
  'err.status.paid': 'an biya',
  'err.status.processing': 'ana shirya shi',
  'err.status.shipped': 'yana kan hanya',
  'err.status.delivered': 'an isar',
  'err.status.cancelled': 'an soke',
  'err.status.expired': 'lokaci ya ƙure',
};

const TABLES: Record<ShopLanguage, Record<ShopMessageKey, string>> = { en, fr, ha };
export const SHOP_MESSAGES = TABLES;

export interface Localized { key: ShopMessageKey; vars?: Record<string, string | number | bigint> }

/** Validation messages that are written in English at the point of validation, mapped to their catalogue keys. */
export const VALIDATION_KEYS: Record<string, ShopMessageKey> = { 'Give an email address or a phone number so we can reply': 'err.enquiry.contact' };

export const hasMessage = (key: string): key is ShopMessageKey => key in en;

export function shopMessage(lang: ShopLanguage, key: ShopMessageKey, vars?: Localized['vars']): string {
  const text = TABLES[lang][key] ?? en[key];
  // A value written "@err.status.paid" is itself a catalogue key, worded in the same language.
  const value = (v: string | number | bigint) => (typeof v === 'string' && v.startsWith('@') && hasMessage(v.slice(1)) ? TABLES[lang][v.slice(1) as ShopMessageKey] : String(v));
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? value(vars[name]!) : m)) : text;
}

/** The language in an Accept-Language header ("fr-NG,fr;q=0.9"): the first of ours that appears, else English. */
export function languageOf(header: string | string[] | undefined): ShopLanguage {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  for (const part of raw.split(',')) {
    const base = part.trim().split(/[;-]/)[0]!.toLowerCase();
    if (base === 'en' || base === 'fr' || base === 'ha') return base;
  }
  return 'en';
}

/** Routes whose answers are read by shoppers rather than staff. */
export const isShopperRoute = (url: string) => url.startsWith('/shop/');

import type { ShopLanguage } from '../shop/translations.js';

/** The wording of order emails and notifications, per language. English is the reference; a missing language falls back to it. */
interface Copy {
  hello(name: string): string;
  order(no: string): string;
  delivery: string;
  free: string;
  total: string;
  view: string;
  bankPay(amount: string, bank: string, accountName: string, accountNumber: string): string;
  bankRef(no: string, until: string): string;
  ourBank: string;
  ourCourier: string;
  events: Record<string, (o: any) => { subject: string; lead: string }>;
}

const en: Copy = {
  hello: (name) => `Hello ${name},`,
  order: (no) => `Order ${no}`,
  delivery: 'Delivery',
  free: 'Free',
  total: 'Total',
  view: 'View your order',
  bankPay: (amount, bank, accountName, accountNumber) => `Pay ${amount} to ${bank}, account name ${accountName}, account number ${accountNumber}.`,
  bankRef: (no, until) => `Use ${no} as the payment reference. We hold your order until ${until}.`,
  ourBank: 'our bank',
  ourCourier: 'our courier',
  events: {
    'order.place': (o) => ({ subject: `We have your order ${o.orderNo}`, lead: o.paymentMethod === 'bank_transfer' ? 'Thank you for your order. Please pay by bank transfer to confirm it.' : 'Thank you for your order. Please complete your card payment to confirm it.' }),
    'order.payment': (o) => ({ subject: `Payment received for ${o.orderNo}`, lead: 'We have received your payment. We will prepare your order now.' }),
    'order.ship': (o) => ({ subject: `Your order ${o.orderNo} is on its way`, lead: o.trackingRef ? `Your order has been sent with ${o.carrier ?? 'our courier'}. Tracking number: ${o.trackingRef}.` : 'Your order has been sent.' }),
    'order.deliver': (o) => ({ subject: `Your order ${o.orderNo} was delivered`, lead: 'Your order has been delivered. We hope you love it — a review helps other shoppers.' }),
    'order.cancel': (o) => ({ subject: `Your order ${o.orderNo} was cancelled`, lead: o.refundDueMinor > 0 ? 'Your order was cancelled. We owe you a refund and will be in touch about it.' : 'Your order was cancelled and nothing has been charged.' }),
    'order.refund_paid': (o) => ({ subject: `Refund sent for ${o.orderNo}`, lead: 'We have sent your refund. Card refunds can take a few working days to show on your statement; bank refunds are usually quicker.' }),
    'order.expire': (o) => ({ subject: `Your order ${o.orderNo} has lapsed`, lead: 'We did not receive payment in time, so the fabric was released. You are welcome to order again.' }),
  },
};

const fr: Copy = {
  hello: (name) => `Bonjour ${name},`,
  order: (no) => `Commande ${no}`,
  delivery: 'Livraison',
  free: 'Gratuite',
  total: 'Total',
  view: 'Voir votre commande',
  bankPay: (amount, bank, accountName, accountNumber) => `Virez ${amount} à ${bank}, nom du compte : ${accountName}, numéro de compte : ${accountNumber}.`,
  bankRef: (no, until) => `Indiquez ${no} comme référence du paiement. Nous gardons votre commande jusqu’au ${until}.`,
  ourBank: 'notre banque',
  ourCourier: 'notre transporteur',
  events: {
    'order.place': (o) => ({ subject: `Nous avons bien reçu votre commande ${o.orderNo}`, lead: o.paymentMethod === 'bank_transfer' ? 'Merci pour votre commande. Veuillez payer par virement bancaire pour la confirmer.' : 'Merci pour votre commande. Veuillez finaliser votre paiement par carte pour la confirmer.' }),
    'order.payment': (o) => ({ subject: `Paiement reçu pour ${o.orderNo}`, lead: 'Nous avons bien reçu votre paiement. Nous préparons votre commande.' }),
    'order.ship': (o) => ({ subject: `Votre commande ${o.orderNo} est en route`, lead: o.trackingRef ? `Votre commande a été expédiée avec ${o.carrier ?? 'notre transporteur'}. Numéro de suivi : ${o.trackingRef}.` : 'Votre commande a été expédiée.' }),
    'order.deliver': (o) => ({ subject: `Votre commande ${o.orderNo} a été livrée`, lead: 'Votre commande a été livrée. Nous espérons qu’elle vous plaît — un avis aide les autres clients.' }),
    'order.cancel': (o) => ({ subject: `Votre commande ${o.orderNo} a été annulée`, lead: o.refundDueMinor > 0 ? 'Votre commande a été annulée. Nous vous devons un remboursement et nous vous contacterons à ce sujet.' : 'Votre commande a été annulée et rien n’a été débité.' }),
    'order.refund_paid': (o) => ({ subject: `Remboursement envoyé pour ${o.orderNo}`, lead: 'Nous avons envoyé votre remboursement. Les remboursements par carte peuvent mettre quelques jours ouvrés à apparaître sur votre relevé ; les virements sont généralement plus rapides.' }),
    'order.expire': (o) => ({ subject: `Votre commande ${o.orderNo} a expiré`, lead: 'Nous n’avons pas reçu le paiement à temps, le tissu a donc été libéré. Vous pouvez passer une nouvelle commande quand vous voulez.' }),
  },
};

// First draft; a Hausa speaker should read it before launch (see docs/operations/SHOP_LANGUAGES.md).
const ha: Copy = {
  hello: (name) => `Sannu ${name},`,
  order: (no) => `Oda ${no}`,
  delivery: 'Isar da kaya',
  free: 'Kyauta',
  total: 'Jimla',
  view: 'Duba odarku',
  bankPay: (amount, bank, accountName, accountNumber) => `Ku tura ${amount} zuwa ${bank}, sunan asusu: ${accountName}, lambar asusu: ${accountNumber}.`,
  bankRef: (no, until) => `Ku yi amfani da ${no} a matsayin bayanin biya. Za mu riƙe odarku har ${until}.`,
  ourBank: 'bankinmu',
  ourCourier: 'mai kai kayanmu',
  events: {
    'order.place': (o) => ({ subject: `Mun karɓi odarku ${o.orderNo}`, lead: o.paymentMethod === 'bank_transfer' ? 'Mun gode da odarku. Da fatan ku biya ta tura kuɗi a banki don tabbatar da shi.' : 'Mun gode da odarku. Da fatan ku kammala biyan da kati don tabbatar da shi.' }),
    'order.payment': (o) => ({ subject: `Mun karɓi biyanku na ${o.orderNo}`, lead: 'Mun karɓi biyanku. Yanzu za mu shirya odarku.' }),
    'order.ship': (o) => ({ subject: `Odarku ${o.orderNo} yana kan hanya`, lead: o.trackingRef ? `An aika odarku ta ${o.carrier ?? 'mai kai kayanmu'}. Lambar bin diddigi: ${o.trackingRef}.` : 'An aika odarku.' }),
    'order.deliver': (o) => ({ subject: `An isar da odarku ${o.orderNo}`, lead: 'An isar da odarku. Muna fatan ya yi muku daɗi — sharhi yana taimaka wa sauran masu saye.' }),
    'order.cancel': (o) => ({ subject: `An soke odarku ${o.orderNo}`, lead: o.refundDueMinor > 0 ? 'An soke odarku. Muna bin ku kuɗi, za mu tuntuɓe ku game da shi.' : 'An soke odarku kuma ba a cire kuɗi ba.' }),
    'order.refund_paid': (o) => ({ subject: `An mayar da kuɗi na ${o.orderNo}`, lead: 'Mun mayar muku da kuɗinku. Mayarwa ta kati na iya ɗaukar kwanakin aiki kaɗan kafin ya bayyana a bayanin asusunku; na banki yawanci sun fi sauri.' }),
    'order.expire': (o) => ({ subject: `Lokacin odarku ${o.orderNo} ya ƙure`, lead: 'Ba mu karɓi biya a kan lokaci ba, don haka an saki yadin. Kuna iya sake yin oda a duk lokacin da kuke so.' }),
  },
};

const COPY: Record<ShopLanguage, Copy> = { en, fr, ha };
export const orderCopy = (lang: string | null | undefined): Copy => COPY[(lang as ShopLanguage) ?? 'en'] ?? en;
export const ORDER_EVENT_TYPES = Object.keys(en.events);

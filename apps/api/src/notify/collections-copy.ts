import type { ShopLanguage } from '../shop/translations.js';

/** The wording of payment reminders, per language. English is the reference. */
export type Stage = 'due_soon' | 'overdue_1' | 'overdue_7' | 'overdue_14' | 'hold' | 'manual';

interface Copy {
  hello(name: string): string;
  subject(stage: Stage, orderNo: string): string;
  lead(stage: Stage, o: { orderNo: string; amount: string; dueOn: string; days: number; holdDays: number }): string;
  invoices: string;
  line(orderNo: string, amount: string, dueOn: string): string;
  pay(bank: string, accountName: string, accountNumber: string): string;
  ref: string;
  view: string;
  thanks: string;
}

const en: Copy = {
  hello: (n) => `Hello ${n},`,
  subject: (s, no) => ({ due_soon: `Payment due soon for ${no}`, overdue_1: `Payment overdue for ${no}`, overdue_7: `Reminder: ${no} is a week overdue`, overdue_14: `Second reminder: ${no} is two weeks overdue`, hold: `Your trade account is on hold`, manual: `Reminder: balance owing on your trade account` })[s],
  lead: (s, o) => ({
    due_soon: `This is a friendly reminder that ${o.amount} for order ${o.orderNo} is due on ${o.dueOn}.`,
    overdue_1: `We have not yet received ${o.amount} for order ${o.orderNo}, which was due on ${o.dueOn}. If you have already paid, thank you, and please ignore this message.`,
    overdue_7: `Order ${o.orderNo} (${o.amount}) is now a week past its due date of ${o.dueOn}. Please arrange payment this week.`,
    overdue_14: `Order ${o.orderNo} (${o.amount}) is now two weeks past its due date of ${o.dueOn}. Please pay now, or tell us when we can expect payment.`,
    hold: `Because ${o.amount} for order ${o.orderNo} has been overdue for ${o.days} days, your trade account is on hold: trade prices and orders on account are paused. Pay what is overdue and the hold is lifted automatically.`,
    manual: `This is a reminder of the balance owing on your trade account.`,
  })[s],
  invoices: 'Outstanding orders:',
  line: (no, amount, due) => `- ${no}: ${amount}, due ${due}`,
  pay: (bank, name, no) => `Pay by transfer to ${bank}, account name ${name}, account number ${no}.`,
  ref: 'Use the order number as the payment reference.',
  view: 'See your account',
  thanks: 'Thank you for trading with us.',
};

const fr: Copy = {
  hello: (n) => `Bonjour ${n},`,
  subject: (s, no) => ({ due_soon: `Échéance proche pour ${no}`, overdue_1: `Paiement en retard pour ${no}`, overdue_7: `Rappel : ${no} est en retard d’une semaine`, overdue_14: `Second rappel : ${no} est en retard de deux semaines`, hold: `Votre compte professionnel est suspendu`, manual: `Rappel : solde dû sur votre compte professionnel` })[s],
  lead: (s, o) => ({
    due_soon: `Petit rappel : ${o.amount} pour la commande ${o.orderNo} sont à régler avant le ${o.dueOn}.`,
    overdue_1: `Nous n’avons pas encore reçu ${o.amount} pour la commande ${o.orderNo}, exigible le ${o.dueOn}. Si vous avez déjà payé, merci, et ignorez ce message.`,
    overdue_7: `La commande ${o.orderNo} (${o.amount}) a une semaine de retard sur son échéance du ${o.dueOn}. Merci d’organiser le paiement cette semaine.`,
    overdue_14: `La commande ${o.orderNo} (${o.amount}) a deux semaines de retard sur son échéance du ${o.dueOn}. Merci de payer maintenant, ou de nous dire quand nous pouvons attendre le paiement.`,
    hold: `Comme ${o.amount} pour la commande ${o.orderNo} sont en retard depuis ${o.days} jours, votre compte professionnel est suspendu : les tarifs professionnels et les commandes sur compte sont en pause. Réglez le retard et la suspension sera levée automatiquement.`,
    manual: `Voici un rappel du solde dû sur votre compte professionnel.`,
  })[s],
  invoices: 'Commandes à régler :',
  line: (no, amount, due) => `- ${no} : ${amount}, échéance le ${due}`,
  pay: (bank, name, no) => `Payez par virement à ${bank}, nom du compte : ${name}, numéro de compte : ${no}.`,
  ref: 'Indiquez le numéro de commande comme référence du paiement.',
  view: 'Voir votre compte',
  thanks: 'Merci de votre confiance.',
};

// First draft; a Hausa speaker should read it before launch (see docs/operations/SHOP_LANGUAGES.md).
const ha: Copy = {
  hello: (n) => `Sannu ${n},`,
  subject: (s, no) => ({ due_soon: `Lokacin biyan ${no} ya kusa`, overdue_1: `Biyan ${no} ya wuce lokaci`, overdue_7: `Tunatarwa: biyan ${no} ya wuce lokaci da mako ɗaya`, overdue_14: `Tunatarwa ta biyu: biyan ${no} ya wuce lokaci da makonni biyu`, hold: `An dakatar da asusun ɗan kasuwanku`, manual: `Tunatarwa: akwai kuɗin da ake bin ku a asusun ɗan kasuwanku` })[s],
  lead: (s, o) => ({
    due_soon: `Wannan tunatarwa ce cewa ${o.amount} na oda ${o.orderNo} za a biya ranar ${o.dueOn}.`,
    overdue_1: `Ba mu karɓi ${o.amount} na oda ${o.orderNo} ba tukuna, wanda lokacinsa ya kasance ${o.dueOn}. Idan kun riga kun biya, mun gode, ku yi watsi da wannan saƙon.`,
    overdue_7: `Oda ${o.orderNo} (${o.amount}) ya wuce ranar biyansa ${o.dueOn} da mako ɗaya. Da fatan ku shirya biya a wannan makon.`,
    overdue_14: `Oda ${o.orderNo} (${o.amount}) ya wuce ranar biyansa ${o.dueOn} da makonni biyu. Da fatan ku biya yanzu, ko ku gaya mana lokacin da za mu sa ran biyan.`,
    hold: `Saboda ${o.amount} na oda ${o.orderNo} ya wuce lokaci da kwanaki ${o.days}, an dakatar da asusun ɗan kasuwanku: farashin ’yan kasuwa da oda a kan asusu sun tsaya. Ku biya abin da ya wuce lokaci, za a cire dakatarwar kai-tsaye.`,
    manual: `Wannan tunatarwa ce game da kuɗin da ake bin ku a asusun ɗan kasuwanku.`,
  })[s],
  invoices: 'Odojin da ba a biya ba:',
  line: (no, amount, due) => `- ${no}: ${amount}, ranar biya ${due}`,
  pay: (bank, name, no) => `Ku biya ta tura kuɗi zuwa ${bank}, sunan asusu: ${name}, lambar asusu: ${no}.`,
  ref: 'Ku yi amfani da lambar oda a matsayin bayanin biya.',
  view: 'Duba asusunku',
  thanks: 'Mun gode da yin kasuwanci da mu.',
};

const COPY: Record<ShopLanguage, Copy> = { en, fr, ha };
export const collectionsCopy = (lang: string | null | undefined): Copy => COPY[(lang as ShopLanguage) ?? 'en'] ?? en;

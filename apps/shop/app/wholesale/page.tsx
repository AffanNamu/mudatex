import type { Metadata } from 'next';
import { getStore } from '@/lib/api';
import { whatsappLink } from '@/lib/format';

export const metadata: Metadata = { title: 'Wholesale' };

export default async function Wholesale() {
  const store = await getStore();
  if (!store) return null;
  const wa = whatsappLink(store.contact.whatsapp, 'Hello, I would like to open a wholesale account.');
  return (
    <div className="wrap section prose">
      <h1>Wholesale</h1>
      <p>Buying by the roll or the bale for your shop or market stall? We offer wholesale pricing, standing orders and delivery to Kano, Kaduna, Katsina, Sokoto, Gombe and beyond.</p>
      {wa ? <p><a className="btn" href={wa} target="_blank" rel="noopener noreferrer">Talk to our wholesale desk</a></p> : <p className="muted">Wholesale contact details will be added soon.</p>}
      <p className="small muted">Online trade accounts with credit terms and statements are on the way.</p>
    </div>
  );
}

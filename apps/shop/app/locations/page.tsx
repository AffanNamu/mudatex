import type { Metadata } from 'next';
import { getStore } from '@/lib/api';

export const metadata: Metadata = { title: 'Find us' };

const CITIES = ['Kano (Kwari Market, our flagship)', 'Kaduna', 'Katsina', 'Sokoto', 'Gombe'];

export default async function Locations() {
  const store = await getStore();
  return (
    <div className="wrap section prose">
      <h1>Find us</h1>
      <p>You can shop online, or visit us in person:</p>
      <ul>{CITIES.map((c) => <li key={c}>{c}</li>)}</ul>
      {store?.contact.address && <p><strong>Head office:</strong> {store.contact.address}</p>}
      <p className="small muted">Exact shop addresses and opening hours are to be added by the company.</p>
    </div>
  );
}

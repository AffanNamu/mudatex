import type { Metadata } from 'next';
import { getStore } from '@/lib/api';
import { T } from '@/lib/i18n';

export const metadata: Metadata = { title: 'Find us' };

const CITIES = ['locations.kano', 'Kaduna', 'Katsina', 'Sokoto', 'Gombe'];

export default async function Locations() {
  const store = await getStore();
  return (
    <div className="wrap section prose">
      <h1><T k="locations.title" /></h1>
      <p><T k="locations.text" /></p>
      <ul>{CITIES.map((c) => <li key={c}>{c.startsWith('locations.') ? <T k={c} /> : c}</li>)}</ul>
      {store?.contact.address && <p><strong><T k="locations.head" /></strong> {store.contact.address}</p>}
      <p className="small muted"><T k="locations.tbc" /></p>
    </div>
  );
}

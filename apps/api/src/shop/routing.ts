import type { Db, Tx } from '../db.js';

export interface FulfilmentArea { locationId: string; countryCode: string; states: string[]; priority: number }

/**
 * The storefront's stock locations in the order they should be tried for one delivery address: first those whose area names
 * the address's state, then those that serve the whole country, each by priority; every other location follows in its listed
 * order. Locations without any area are never excluded: routing only changes the order, so an order is never refused because of it.
 */
export function routeOrder(locationIds: string[], areas: FulfilmentArea[], countryCode: string, state: string): string[] {
  const country = countryCode.trim().toUpperCase();
  const st = state.trim().toLowerCase();
  const rank = new Map<string, [number, number]>();
  for (const a of areas) {
    if (a.countryCode.trim().toUpperCase() !== country || !locationIds.includes(a.locationId)) continue;
    const specific = a.states.length > 0;
    if (specific && !a.states.includes(st)) continue;
    const r: [number, number] = [specific ? 0 : 1, a.priority];
    const prior = rank.get(a.locationId);
    if (!prior || r[0] < prior[0] || (r[0] === prior[0] && r[1] < prior[1])) rank.set(a.locationId, r);
  }
  const index = new Map(locationIds.map((id, i) => [id, i]));
  const serving = [...rank.keys()].sort((x, y) => rank.get(x)![0] - rank.get(y)![0] || rank.get(x)![1] - rank.get(y)![1] || index.get(x)! - index.get(y)!);
  return [...serving, ...locationIds.filter((id) => !rank.has(id))];
}

export async function loadAreas(q: Pick<Db, 'query'> | Tx, storefrontId: string): Promise<FulfilmentArea[]> {
  const { rows } = await q.query<{ locationId: string; countryCode: string; states: string[]; priority: number }>(
    `SELECT location_id AS "locationId", country_code AS "countryCode", states, priority FROM fulfilment_areas WHERE storefront_id = $1`, [storefrontId]);
  return rows;
}

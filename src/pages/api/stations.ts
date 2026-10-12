import type { APIRoute } from 'astro';
import { radioBrowserFetch } from '../../lib/radio-browser';

export const prerender = true;

const API_BY_CODE = '/json/stations/bycountrycodeexact/BG';
const API_BY_NAME = '/json/stations/bycountry/Bulgaria';
const QUERY = '?limit=2000&hidebroken=true&order=clickcount&reverse=true';

export const GET: APIRoute = async () => {
  const [r1, r2] = await Promise.all([
    radioBrowserFetch(API_BY_CODE + QUERY),
    radioBrowserFetch(API_BY_NAME + QUERY).catch(() => null),
  ]);

  const raw1 = r1.ok ? await r1.json() : [];
  const raw2 = r2 && r2.ok ? await r2.json() : [];

  const seenUuid = new Set(raw1.map((s: any) => s.stationuuid));
  const merged = [...raw1, ...raw2.filter((s: any) => !seenUuid.has(s.stationuuid))];

  const seenUrl = new Set<string>();
  const deduped: any[] = [];
  for (const s of merged) {
    const url = s.url_resolved;
    if (!url || !url.startsWith('https://') || seenUrl.has(url)) continue;
    seenUrl.add(url);
    deduped.push(s);
  }

  // Fail the build rather than deploy a site with no stations; the previous
  // deploy stays live until Radio Browser answers again.
  if (deduped.length === 0) {
    throw new Error(`Radio Browser returned no playable Bulgarian stations (HTTP ${r1.status})`);
  }

  return new Response(JSON.stringify(deduped), {
    headers: { 'Content-Type': 'application/json' },
  });
};

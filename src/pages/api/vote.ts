import type { APIRoute } from 'astro';
import { radioBrowserFetch } from '../../lib/radio-browser';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const { uuid } = await request.json();
    if (!uuid || typeof uuid !== 'string') {
      return new Response(JSON.stringify({ error: 'missing uuid' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const res = await radioBrowserFetch(`/json/vote/${encodeURIComponent(uuid)}`, {
      method: 'POST',
      timeoutMs: 5_000,
    });
    const data = await res.json();

    return new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(JSON.stringify({ error: 'vote failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

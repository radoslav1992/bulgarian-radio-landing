// Radio Browser serves the same API from several community-run mirrors, and
// any single one can be down or drop connections (a de1 TLS failure once took
// down a deploy). Requests try each mirror in turn until one answers.
const MIRRORS = [
  'https://de1.api.radio-browser.info',
  'https://de2.api.radio-browser.info',
  'https://fi1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://at1.api.radio-browser.info',
  // DNS round-robin over whichever mirrors are currently live.
  'https://all.api.radio-browser.info',
];

// Radio Browser asks API clients to identify themselves.
const USER_AGENT = 'bulgariaradio.com';

function describe(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  // undici wraps the real network error ("fetch failed") in `cause`.
  return err.cause instanceof Error ? err.cause.message : err.message;
}

/**
 * Fetch an API path (e.g. `/json/stations/...`) from the first mirror that
 * responds without a network error or 5xx. Throws when every mirror fails.
 */
export async function radioBrowserFetch(
  path: string,
  { method = 'GET', timeoutMs = 15_000 }: { method?: string; timeoutMs?: number } = {},
): Promise<Response> {
  const errors: string[] = [];
  for (const base of MIRRORS) {
    try {
      const res = await fetch(base + path, {
        method,
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status < 500) return res;
      errors.push(`${base}: HTTP ${res.status}`);
    } catch (err) {
      errors.push(`${base}: ${describe(err)}`);
    }
  }
  throw new Error(`All Radio Browser mirrors failed for ${path}:\n  ${errors.join('\n  ')}`);
}

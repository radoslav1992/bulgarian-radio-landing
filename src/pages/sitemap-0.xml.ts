import { getCollection } from 'astro:content';

export const prerender = true;

const SITE = 'https://bulgariaradio.com';

const staticPages = [
  { loc: '/', changefreq: 'weekly', priority: '1.0' },
  { loc: '/stations', changefreq: 'weekly', priority: '0.9' },
  { loc: '/blog', changefreq: 'weekly', priority: '0.9' },
  { loc: '/about', changefreq: 'monthly', priority: '0.7' },
  { loc: '/contact', changefreq: 'monthly', priority: '0.7' },
  { loc: '/privacy-policy', changefreq: 'yearly', priority: '0.5' },
  { loc: '/terms', changefreq: 'yearly', priority: '0.5' },
];

export async function GET() {
  const [posts, stations] = await Promise.all([
    getCollection('blog'),
    getCollection('stations'),
  ]);

  const blogEntries = posts
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime())
    .map((post) => ({
      loc: `/blog/${post.slug}`,
      lastmod: post.data.updated || post.data.date,
      changefreq: 'monthly',
      priority: '0.8',
    }));

  const stationEntries = stations
    .sort((a, b) => a.data.name.localeCompare(b.data.name, 'bg'))
    .map((s) => ({
      loc: `/stations/${s.slug}`,
      changefreq: 'monthly',
      priority: '0.8',
    }));

  // Only blog entries carry a real lastmod; stamping build time on every URL
  // would just teach crawlers to ignore the field.
  const allEntries: Array<{ loc: string; changefreq: string; priority: string; lastmod?: string }> = [
    ...staticPages,
    ...stationEntries,
    ...blogEntries,
  ];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${allEntries
  .map(
    (e) => `  <url>
    <loc>${SITE}${e.loc}</loc>${e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : ''}
    <changefreq>${e.changefreq}</changefreq>
    <priority>${e.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
}

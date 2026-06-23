import { getCollection } from 'astro:content';

export const prerender = true;

const SITE = 'https://bulgariaradio.com';

export async function GET() {
  const [posts, stations] = await Promise.all([
    getCollection('blog'),
    getCollection('stations'),
  ]);

  const stationLines = stations
    .sort((a, b) => a.data.name.localeCompare(b.data.name, 'bg'))
    .map((s) => `- [${s.data.name}](${SITE}/stations/${s.slug}): ${s.data.description}`)
    .join('\n');

  const blogLines = posts
    .sort((a, b) => new Date(b.data.date).getTime() - new Date(a.data.date).getTime())
    .map((p) => `- [${p.data.title}](${SITE}/blog/${p.slug}): ${p.data.description}`)
    .join('\n');

  const body = `# Радио България (bulgariaradio.com)

> Безплатен уеб плейър и справочник за български радио станции. Над 100 станции
> на живо — поп, рок, фолк, джаз, новини и спорт — директно в браузъра, без
> регистрация и без такси. Каталогът се захранва от отворената база данни
> Radio Browser (radio-browser.info); самите потоци се излъчват от съответните радиа.

Free online player and directory for Bulgarian radio stations. Listen to 100+
Bulgarian stations live in the browser, no sign-up required. Content is in Bulgarian.

## Основни страници

- [Слушай на живо](${SITE}/): уеб плейър с търсене, жанрови и градски филтри
- [Справочник на станциите](${SITE}/stations): история, формат, честоти и собственост на българските радиа
- [Блог](${SITE}/blog): статии за българското радио и музика
- [За нас](${SITE}/about): информация за проекта
- [Контакт](${SITE}/contact): info@bulgariaradio.com

## Радио станции

${stationLines}

## Статии

${blogLines}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

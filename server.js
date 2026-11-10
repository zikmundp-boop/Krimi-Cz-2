'use strict';
// Server bez externích knihoven (Node 18+). Stahuje titulky z Google News RSS pro každý kraj ČR.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const REFRESH_MS = 20 * 60 * 1000;     // jak často se zprávy stahují
const MAX_AGE_MS = 48 * 3600 * 1000;   // zprávy starší než 48 h se zahodí
const MAX_ITEMS = 15;                  // max. zpráv na kraj

const CRIME = '(policie OR kriminalita OR vražda OR loupež OR krádež OR zadržen OR podvod OR nehoda)';
const REGIONS = {
  PHA: { name: 'Praha', q: 'Praha' },
  STC: { name: 'Středočeský kraj', q: '"Středočeský kraj" OR Kladno OR Mladá Boleslav OR Kolín' },
  JHC: { name: 'Jihočeský kraj', q: '"Jihočeský kraj" OR "České Budějovice" OR Tábor OR Písek' },
  PLK: { name: 'Plzeňský kraj', q: '"Plzeňský kraj" OR Plzeň OR Klatovy' },
  KVK: { name: 'Karlovarský kraj', q: '"Karlovarský kraj" OR "Karlovy Vary" OR Cheb OR Sokolov' },
  ULK: { name: 'Ústecký kraj', q: '"Ústecký kraj" OR "Ústí nad Labem" OR Most OR Teplice OR Děčín' },
  LBK: { name: 'Liberecký kraj', q: '"Liberecký kraj" OR Liberec OR Jablonec OR "Česká Lípa"' },
  HKK: { name: 'Královéhradecký kraj', q: '"Královéhradecký kraj" OR "Hradec Králové" OR Trutnov OR Náchod' },
  PAK: { name: 'Pardubický kraj', q: '"Pardubický kraj" OR Pardubice OR Chrudim OR Svitavy' },
  VYS: { name: 'Vysočina', q: 'Vysočina OR Jihlava OR Třebíč OR "Žďár nad Sázavou"' },
  JMK: { name: 'Jihomoravský kraj', q: '"Jihomoravský kraj" OR Brno OR Znojmo OR Břeclav' },
  OLK: { name: 'Olomoucký kraj', q: '"Olomoucký kraj" OR Olomouc OR Prostějov OR Přerov' },
  ZLK: { name: 'Zlínský kraj', q: '"Zlínský kraj" OR Zlín OR Kroměříž OR Vsetín' },
  MSK: { name: 'Moravskoslezský kraj', q: '"Moravskoslezský kraj" OR Ostrava OR Havířov OR Karviná OR Opava' },
};

const cache = { updatedAt: null, states: {} };
for (const [code, r] of Object.entries(REGIONS)) {
  cache.states[code] = { name: r.name, count: 0, items: [], error: null };
}

const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')
  .replace(/<[^>]+>/g, '').trim();

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    let title = tag(block, 'title');
    const source = tag(block, 'source');
    const url = tag(block, 'link');
    const date = new Date(tag(block, 'pubDate'));
    if (!title || !/^https?:\/\//i.test(url) || isNaN(date)) continue;
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
    items.push({ title, url, source, publishedAt: date.toISOString() });
  }
  return items;
}

async function fetchRegion(code) {
  const query = `${CRIME} (${REGIONS[code].q}) when:2d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=cs&gl=CZ&ceid=CZ:cs`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (krimi-cz)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const now = Date.now();
  const seen = new Set();
  return parseRss(await res.text())
    .filter((i) => now - new Date(i.publishedAt) < MAX_AGE_MS)
    .filter((i) => !seen.has(i.title) && seen.add(i.title))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, MAX_ITEMS);
}

let refreshing = false;
async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  for (const code of Object.keys(REGIONS)) {
    try {
      const items = await fetchRegion(code);
      cache.states[code] = { name: REGIONS[code].name, count: items.length, items, error: null };
    } catch (err) {
      // staré zprávy necháme, jen si poznačíme chybu
      cache.states[code].error = err.message;
      console.error(`[${code}]`, err.message);
    }
    cache.updatedAt = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 700)); // šetrně k Googlu
  }
  console.log('Obnoveno', cache.updatedAt);
  refreshing = false;
}

const PAGE = path.join(__dirname, 'public', 'index.html');

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/news') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(cache));
  }
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  if (url === '/' || url === '/index.html') {
    return fs.readFile(PAGE, (err, html) => {
      if (err) { res.writeHead(500); return res.end('Chybí public/index.html'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Nenalezeno');
}).listen(PORT, () => {
  console.log(`Krimi CZ běží na portu ${PORT}`);
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
});

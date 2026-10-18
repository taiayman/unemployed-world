import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { array, text, safeUrl, timestamp, hash, day } from '../util.js';

export function parseFeed(raw) {
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) throw new Error('DTD/entity declarations are not accepted');
  if (XMLValidator.validate(raw) !== true) throw new Error('Invalid feed XML');
  const doc = new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(raw);
  if (!doc.rss && !doc.feed && !doc['rdf:RDF']) throw new Error('Response is not an RSS/Atom feed');
  return array(doc.rss?.channel?.item || doc.feed?.entry || doc['rdf:RDF']?.item).map(item => {
    const link = typeof item.link === 'string' ? item.link : array(item.link).find(l => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'];
    return { title: text(item.title?.['#text'] || item.title), url: safeUrl(link), publishedAt: timestamp(item.pubDate || item.published || item.updated || item['dc:date']) };
  }).filter(item => item.title && item.url);
}

export function newsSources(config, http) {
  const sources = config.feeds.map(feed => ({ name: `news:${feed.name}`, config: feed,
    enabled: !!feed.enabled && !!feed.url, reason: 'No verified RSS URL configured',
    collect: async () => parseFeed(await http.request(feed.url)).slice(0, config.maxItems) }));
  sources.push({ name: 'news:Hugging Face', config: { trending: true }, enabled: config.huggingface, reason: 'Disabled in config', collect: async () => {
    const data = await http.json(`https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=${config.maxItems}`);
    return data.map(m => ({ title: `Trending model: ${m.id}`, url: `https://huggingface.co/${m.id}`, publishedAt: timestamp(m.createdAt) }));
  } });
  sources.push({ name: 'news:arXiv', config: { categories: ['cs.AI', 'cs.CL', 'cs.LG'] }, enabled: config.arxiv, reason: 'Disabled in config', collect: async () =>
    parseFeed(await http.request(`https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=${config.maxItems}`, { minIntervalMs: 3500 })) });
  return sources;
}

export function ingestNews(db, source, item, date = day()) {
  db.prepare('INSERT INTO news VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen')
    .run(hash(item.url), source, item.title.slice(0, 400), item.url, item.publishedAt, date, date);
}

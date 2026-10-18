import { hash, normalize, text, day, timestamp } from '../util.js';

const relevant = /\b(job|jobs|hiring|layoff|layoffs|unemploy\w*|career|careers|recruit\w*|automat\w*|replac\w*)\b/i;
const positive = new Set(['hiring', 'hired', 'growing', 'growth', 'opportunity', 'opportunities', 'optimistic', 'promoted', 'offer', 'offers']);
const negative = new Set(['layoff', 'layoffs', 'fired', 'unemployed', 'unemployment', 'replaced', 'replacing', 'rejected', 'rejection', 'cuts', 'doomed']);

export function sentimentScore(raw) {
  const words = normalize(raw).split(' ');
  if (!relevant.test(words.join(' '))) return null;
  let sum = 0, hits = 0;
  words.forEach((word, i) => {
    let score = positive.has(word) ? 1 : negative.has(word) ? -1 : 0;
    if (!score) return;
    if (words.slice(Math.max(0, i - 3), i).some(w => ['not', 'no', 'never', 'isnt', 'isn'].includes(w))) score *= -1;
    sum += score; hits++;
  });
  return hits ? sum / hits : 0;
}

export function ingestSentiment(db, source, item, date = day()) {
  const score = sentimentScore(text(item.text));
  if (score == null) return false;
  // No usernames, source IDs, URLs, bodies, or quotations are retained.
  const id = hash([source, item.id]);
  const inserted = db.prepare('INSERT OR IGNORE INTO sentiment_seen VALUES(?,?)').run(id, date);
  if (!inserted.changes) return false;
  db.prepare(`INSERT INTO sentiment_daily VALUES(?,?,1,?) ON CONFLICT(day,source)
    DO UPDATE SET count=count+1,score_sum=score_sum+excluded.score_sum`).run(date, source, score);
  return true;
}

export async function blueskySample(config, { WebSocketImpl = WebSocket } = {}) {
  if (!/^wss:\/\//.test(config.url)) throw new Error('Jetstream requires wss');
  const u = new URL(config.url);
  u.searchParams.set('wantedCollections', 'app.bsky.feed.post');
  // Live bounded sample, not a misleading replay of yesterday's backlog.
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(u);
    const out = []; let count = 0, opened = false, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      error ? reject(error) : resolve(out);
    };
    const timer = setTimeout(() => finish(opened ? null : new Error('Jetstream connection timed out')), Math.min(120, config.sampleSeconds) * 1000);
    socket.addEventListener('open', () => { opened = true; });
    socket.addEventListener('error', () => finish(new Error('Jetstream connection failed')));
    socket.addEventListener('close', () => finish(opened ? null : new Error('Jetstream closed before opening')));
    socket.addEventListener('message', event => {
      count++;
      try {
        const data = JSON.parse(event.data), c = data.commit;
        // Ignore updates/deletions. Text is aggregated in memory, never persisted.
        if (c?.operation === 'create' && c.collection === 'app.bsky.feed.post' && relevant.test(c.record?.text || '')) {
          out.push({ id: `${data.did}/${c.rkey}`, text: c.record.text, publishedAt: timestamp(c.record.createdAt) });
        }
      } catch { /* Drop malformed stream messages. */ }
      if (count >= config.maxMessages) finish();
    });
  });
}

export function sentimentSources(config, http) {
  return [
    { name: 'sentiment:hn', enabled: config.hn, config: { query: 'AI jobs' }, reason: 'Disabled in config', collect: async () => {
      const d = await http.json('https://hn.algolia.com/api/v1/search_by_date?tags=comment&query=AI%20jobs&hitsPerPage=100');
      return d.hits.map(h => ({ id: h.objectID, text: h.comment_text, publishedAt: timestamp(h.created_at) }));
    } },
    { name: 'sentiment:bluesky', enabled: config.bluesky.enabled, config: config.bluesky, reason: 'Disabled in config', collect: () => blueskySample(config.bluesky) },
    { name: 'sentiment:reddit', enabled: config.reddit.enabled && config.reddit.approved && !!process.env.REDDIT_CLIENT_ID && !!process.env.REDDIT_CLIENT_SECRET,
      config: config.reddit, reason: 'Requires approved Reddit API access and OAuth credentials; no unauthenticated scraping', collect: async () => {
        const token = await http.json('https://www.reddit.com/api/v1/access_token', { method: 'POST', retries: 0,
          headers: { Authorization: `Basic ${Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
        if (!token.access_token) throw new Error('Reddit OAuth failed');
        const out = [];
        for (const sub of config.reddit.subreddits) {
          if (!/^[a-z0-9_]+$/i.test(sub)) throw new Error('Invalid subreddit');
          const d = await http.json(`https://oauth.reddit.com/r/${sub}/comments?limit=100&raw_json=1`, { headers: { Authorization: `Bearer ${token.access_token}` }, minIntervalMs: 10000 });
          for (const { data: c } of d.data?.children || []) if (c.body && !['[removed]', '[deleted]'].includes(c.body)) out.push({ id: c.name, text: c.body, publishedAt: timestamp(c.created_utc) });
        }
        return out;
      } }
  ];
}

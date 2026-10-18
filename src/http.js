import { sleep } from './util.js';

export class Http {
  constructor(config, { fetchImpl = fetch, sleepImpl = sleep } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.last = new Map();
    this.blocked = new Set();
  }
  async request(url, { method = 'GET', headers = {}, body, retries = 1, minIntervalMs, redirects = 0 } = {}) {
    const host = new URL(url).host;
    if (this.blocked.has(host)) throw new Error(`Host cooling down after rate limit: ${host}`);
    for (let attempt = 0; ; attempt++) {
      const gap = minIntervalMs ?? this.config.minIntervalMs;
      await this.sleep(Math.max(0, gap - (Date.now() - (this.last.get(host) || 0))));
      this.last.set(host, Date.now());
      let response;
      try {
        response = await this.fetch(url, { method, body, headers: {
          'User-Agent': process.env.PIPELINE_USER_AGENT || 'unemployed.world/1.0 (daily research pipeline)',
          Accept: 'application/json, application/rss+xml, application/atom+xml, text/xml', ...headers
        }, signal: AbortSignal.timeout(this.config.timeoutMs), redirect: 'manual' });
      } catch (error) {
        if (method === 'GET' && attempt < retries) { await this.sleep(3000); continue; }
        throw new Error(`Network failure from ${host}: ${error.cause?.code || error.name}`);
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const target = response.headers.get('location');
        await response.body?.cancel();
        const destination = target ? new URL(target, url) : null;
        if (!destination || destination.origin !== new URL(url).origin || destination.protocol !== 'https:' || method !== 'GET' || redirects >= 3) throw new Error(`Unsafe or excessive redirect from ${host}`);
        return this.request(destination.href, { method, headers, body, retries, minIntervalMs, redirects: redirects + 1 });
      }
      if (response.status === 429 || response.status === 503) {
        const raw = response.headers.get('retry-after');
        const wait = raw ? (/^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - Date.now()) : 60000;
        this.blocked.add(host);
        await response.body?.cancel();
        // Never ignore Retry-After or hold the cheap daily runner for minutes.
        throw new Error(`Rate limited by ${host}; cooldown ${Math.max(0, wait)}ms, retry next daily run`);
      }
      if (response.status >= 500 && attempt < retries && method === 'GET') {
        await response.body?.cancel(); await this.sleep(3000 * (attempt + 1)); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} from ${host}`); }
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > this.config.maxBytes) throw new Error(`Response too large from ${host}`);
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      return Buffer.concat(chunks).toString('utf8');
    }
  }
  async json(url, options) { return JSON.parse(await this.request(url, options)); }
}

import { array, text, timestamp, safeUrl, assert } from '../util.js';

const enc = encodeURIComponent;
const url = (base, params) => `${base}?${new URLSearchParams(params)}`;
const place = value => array(value).map(v => typeof v === 'string' ? v : v.name || v.city || '').filter(Boolean).join(', ');

export function normalizeJobs(kind, data, board = '') {
  const containers = {
    greenhouse: data?.jobs, lever: data, ashby: data?.jobs, workable: data?.results || data?.jobs,
    smartrecruiters: data?.content, adzuna: data?.results, usajobs: data?.SearchResult?.SearchResultItems,
    arbeitnow: data?.data, himalayas: data?.jobs, remotive: data?.jobs, remoteok: data
  };
  assert(Array.isArray(containers[kind]), `Unexpected ${kind} response schema; refusing to record zero postings`);
  switch (kind) {
    case 'greenhouse': return array(data.jobs).map(j => ({ id: String(j.id), title: j.title, company: board, location: j.location?.name, description: j.content, url: j.absolute_url, publishedAt: timestamp(j.updated_at) }));
    case 'lever': return array(data).map(j => ({ id: j.id, title: j.text, company: board, location: j.categories?.location, description: `${j.descriptionPlain || j.description || ''} ${array(j.lists).map(l => `${l.text} ${l.content}`).join(' ')} ${j.additionalPlain || ''}`, url: j.hostedUrl, publishedAt: timestamp(j.createdAt) }));
    case 'ashby': return array(data.jobs).map(j => ({ id: j.id || j.jobUrl, title: j.title, company: board, location: [j.location, ...array(j.secondaryLocations).map(l => l.location)].filter(Boolean).join(', '), description: j.descriptionPlain || j.descriptionHtml, url: j.jobUrl, publishedAt: timestamp(j.publishedAt) }));
    case 'workable': return array(data.results || data.jobs).map(j => ({ id: j.shortcode || j.id, title: j.title, company: board, location: place(j.locations || j.location?.city), description: j.description || j.full_description, url: j.url || j.application_url || `https://apply.workable.com/${enc(board)}/j/${enc(j.shortcode)}/`, publishedAt: timestamp(j.published_on || j.created_at) }));
    case 'smartrecruiters': return array(data.content).map(j => ({ id: j.id, title: j.name, company: j.company?.name || board, location: [j.location?.city, j.location?.country].filter(Boolean).join(', '), description: Object.values(j.jobAd?.sections || {}).map(s => `${s.title || ''} ${s.text || ''}`).join(' '), url: j.postingUrl || `https://jobs.smartrecruiters.com/${enc(board)}/${enc(j.id)}`, publishedAt: timestamp(j.releasedDate) }));
    case 'adzuna': return array(data.results).map(j => ({ id: String(j.id), title: j.title, company: j.company?.display_name, location: j.location?.display_name, description: j.description, url: j.redirect_url, publishedAt: timestamp(j.created) }));
    case 'usajobs': return array(data.SearchResult?.SearchResultItems).map(({ MatchedObjectId, MatchedObjectDescriptor: j }) => ({ id: MatchedObjectId, title: j.PositionTitle, company: j.OrganizationName, location: j.PositionLocationDisplay, description: `${j.UserArea?.Details?.JobSummary || ''} ${j.QualificationSummary || ''}`, url: j.PositionURI, publishedAt: timestamp(j.PublicationStartDate) }));
    case 'arbeitnow': return array(data.data).map(j => ({ id: j.slug, title: j.title, company: j.company_name, location: j.location, description: `${j.description || ''} ${j.remote ? 'Remote work' : ''}`, url: j.url, publishedAt: timestamp(j.created_at) }));
    case 'himalayas': return array(data.jobs).map(j => ({ id: j.guid, title: j.title, company: j.companyName, location: place(j.locationRestrictions) || 'Remote worldwide', description: j.description || j.excerpt, url: j.applicationLink, publishedAt: timestamp(j.pubDate) }));
    case 'remotive': return array(data.jobs).map(j => ({ id: String(j.id), title: j.title, company: j.company_name, location: j.candidate_required_location || 'Remote', description: j.description, url: j.url, publishedAt: timestamp(j.publication_date) }));
    case 'remoteok': return array(data).filter(j => j.id && j.position).map(j => ({ id: String(j.id), title: j.position, company: j.company, location: j.location || 'Remote', description: j.description, url: j.url, publishedAt: timestamp(j.date) }));
    default: throw new Error(`Unknown jobs adapter: ${kind}`);
  }
}

function boardConfig(entry) {
  const value = typeof entry === 'string' ? { slug: entry, approved: false } : entry;
  if (!/^[a-z0-9_.-]+$/i.test(value.slug || '')) throw new Error('Invalid company board slug');
  return value;
}

export function jobSources(config, http) {
  const sources = [];
  for (const kind of ['greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters']) {
    for (const entry of config[kind] || []) {
      const b = boardConfig(entry), board = b.slug;
      sources.push({ name: `${kind}:${board}`, config: b, enabled: b.approved === true,
        reason: 'Company board terms must be reviewed; set approved:true',
        collect: async () => {
          let data;
          if (kind === 'greenhouse') data = await http.json(`https://boards-api.greenhouse.io/v1/boards/${enc(board)}/jobs?content=true`);
          if (kind === 'lever') data = await http.json(`https://api.${b.region === 'eu' ? 'eu.' : ''}lever.co/v0/postings/${enc(board)}?mode=json`);
          if (kind === 'ashby') data = await http.json(`https://api.ashbyhq.com/posting-api/job-board/${enc(board)}`);
          if (kind === 'workable') {
            // Public board endpoint, not Workable's private /spi/v3 account API.
            data = await http.json(`https://apply.workable.com/api/v1/widget/accounts/${enc(board)}`);
          }
          if (kind === 'smartrecruiters') {
            const all = [];
            for (let page = 0; page < (b.maxPages || 3); page++) {
              const part = await http.json(url(`https://api.smartrecruiters.com/v1/companies/${enc(board)}/postings`, { limit: 100, offset: page * 100 }));
              all.push(...array(part.content));
              if (all.length >= part.totalFound || !part.content?.length) break;
            }
            data = { content: all };
          }
          return normalizeJobs(kind, data, b.company || board);
        } });
    }
  }
  for (const kind of ['adzuna', 'usajobs', 'arbeitnow', 'himalayas', 'remotive', 'remoteok']) {
    const c = config[kind] || {};
    const restricted = ['himalayas', 'remotive', 'remoteok'].includes(kind);
    const credentials = kind === 'adzuna' ? !!(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY) : kind === 'usajobs' ? !!(process.env.USAJOBS_API_KEY && process.env.USAJOBS_EMAIL) : true;
    sources.push({ name: kind, config: c, enabled: !!c.enabled && credentials && (!restricted || c.approved === true),
      reason: !credentials ? 'Missing API credentials' : restricted && !c.approved ? 'Review redistribution, attribution and AI-processing terms before approval' : 'Disabled in config',
      collect: async () => {
        const result = []; let cursor;
        for (let page = 1; page <= (c.maxPages || 1); page++) {
          let data;
          if (kind === 'adzuna') data = await http.json(url(`https://api.adzuna.com/v1/api/jobs/${enc(c.country || 'us')}/search/${page}`, { app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY, results_per_page: 50, what: c.query || '', sort_by: 'date' }));
          if (kind === 'usajobs') data = await http.json(url('https://data.usajobs.gov/api/search', { Keyword: c.keyword || '', ResultsPerPage: 100, Page: page }), { headers: { Host: 'data.usajobs.gov', 'User-Agent': process.env.USAJOBS_EMAIL, 'Authorization-Key': process.env.USAJOBS_API_KEY } });
          if (kind === 'arbeitnow') data = await http.json(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
          if (kind === 'himalayas') data = await http.json(url('https://himalayas.app/jobs/api', { limit: 20, ...(cursor ? { cursor } : {}) }), { headers: process.env.HIMALAYAS_API_KEY ? { Authorization: `Bearer ${process.env.HIMALAYAS_API_KEY}` } : {} });
          if (kind === 'remotive') data = await http.json('https://remotive.com/api/remote-jobs');
          if (kind === 'remoteok') data = await http.json('https://remoteok.com/api');
          const rows = normalizeJobs(kind, data);
          result.push(...rows);
          cursor = data.nextCursor;
          if (!rows.length || kind === 'himalayas' && !cursor || ['remotive', 'remoteok'].includes(kind)) break;
        }
        return result;
      } });
  }
  const c = config.hnHiring || {};
  sources.push({ name: 'hn-hiring', config: c, enabled: !!c.enabled, reason: 'Disabled in config', collect: async () => {
    const stories = await http.json(url('https://hn.algolia.com/api/v1/search_by_date', { tags: 'story,author_whoishiring', query: 'Ask HN: Who is hiring?', hitsPerPage: 10 }));
    const thread = stories.hits?.find(h => /^Ask HN: Who is hiring\? \(/i.test(h.title));
    if (!thread) throw new Error('Current Who is hiring thread not found');
    const out = [];
    for (let page = 0; page < (c.maxPages || 1); page++) {
      const data = await http.json(url('https://hn.algolia.com/api/v1/search_by_date', { tags: `comment,story_${thread.objectID}`, hitsPerPage: 100, page }));
      for (const h of data.hits || []) {
        // Only top-level offers; replies are not extra job postings.
        if (String(h.parent_id) !== String(thread.objectID)) continue;
        const line = text(h.comment_text).slice(0, 500), parts = line.split(/\s*[|]\s*/);
        if (parts.length < 2 || parts[0].length > 100) continue;
        const title = parts.slice(1).find(p => /engineer|developer|designer|manager|scientist|analyst|sales|support|research|hiring/i.test(p));
        if (!title) continue;
        out.push({ id: h.objectID, company: parts[0], title: title.slice(0, 180), location: parts.filter(p => /remote|onsite|hybrid|london|york|francisco|berlin/i.test(p)).join(', '), description: h.comment_text, url: `https://news.ycombinator.com/item?id=${h.objectID}`, publishedAt: timestamp(h.created_at) });
      }
      if (page + 1 >= data.nbPages) break;
    }
    return out;
  } });
  return sources;
}

export function validatePosting(item) { return !!(text(item.title) && text(item.company) && safeUrl(item.url)); }

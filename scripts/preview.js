import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const allowed = new Map([['/', ['site/index.html', 'text/html; charset=utf-8']], ['/index.html', ['site/index.html', 'text/html; charset=utf-8']], ['/jobs.json', ['site/jobs.json', 'application/json']]]);
createServer(async (req, res) => {
  const entry = allowed.get(new URL(req.url, 'http://localhost').pathname);
  if (!entry) { res.writeHead(404); res.end(); return; }
  try { res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' }); res.end(await readFile(entry[0])); }
  catch { res.writeHead(404); res.end('Run npm run pipeline -- --no-llm first.'); }
}).listen(8788, '127.0.0.1', () => console.log('http://127.0.0.1:8788'));

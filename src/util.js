import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const hash = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value)).digest('hex');
export const day = (date = new Date()) => date.toISOString().slice(0, 10);
export const ago = (days, date = new Date()) => day(new Date(date.getTime() - days * 86400000));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
export function text(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, m => ({ '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[m]).replace(/\s+/g, ' ').trim();
}
export const normalize = value => text(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function safeUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function canonicalUrl(value) {
  const valid = safeUrl(value);
  if (!valid) return '';
  const u = new URL(valid);
  u.hash = '';
  for (const key of [...u.searchParams.keys()]) if (/^(utm_|ref$|source$|gh_src$)/i.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  return u.href.replace(/\/$/, '');
}
export function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, value);
  renameSync(`${path}.tmp`, path);
}
export function timestamp(value) {
  if (!value) return null;
  const d = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
export function assert(condition, message) { if (!condition) throw new Error(message); }

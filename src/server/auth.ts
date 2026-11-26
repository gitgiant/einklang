// Room token + bind addresses. The server only listens on localhost and the tailnet, and every
// HTTP and WebSocket request must carry the room token (?t=, or the cookie set by a ?t= page load).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';

export const COOKIE = 'einklang_t';

/** Token from $EINKLANG_TOKEN, else from `file`, else freshly generated and saved to `file`. */
export function loadToken(file: string): string {
  const env = process.env.EINKLANG_TOKEN?.trim();
  if (env) return env;
  try { const t = fs.readFileSync(file, 'utf8').trim(); if (t) return t; } catch { /* first run */ }
  const t = crypto.randomBytes(12).toString('base64url');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

function eq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function cookieToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Returns how the request is authorized: by query param, by cookie, or not at all. */
export function authorize(req: IncomingMessage, token: string): 'query' | 'cookie' | null {
  const q = new URL(req.url ?? '/', 'http://x').searchParams.get('t');
  if (q && eq(q, token)) return 'query';
  const c = cookieToken(req);
  if (c && eq(c, token)) return 'cookie';
  return null;
}

export const setCookie = (token: string): string => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;

/** Tailscale hands out addresses from 100.64.0.0/10 (and fd7a:115c:a1e0::/48 for IPv6). */
export function isTailnet(addr: string): boolean {
  if (addr.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  const m = /^100\.(\d+)\./.exec(addr);
  return !!m && +m[1] >= 64 && +m[1] <= 127;
}

/** localhost + every tailnet address; $BIND (comma-separated) overrides, e.g. BIND=0.0.0.0. */
export function bindAddresses(): string[] {
  const env = process.env.BIND?.trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const tail = Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && isTailnet(i.address))
    .map((i) => i.address);
  return ['127.0.0.1', ...new Set(tail)];
}

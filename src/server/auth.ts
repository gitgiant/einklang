// Room token + bind addresses. The server only listens on localhost and the tailnet (and, with
// $EINKLANG_LAN=1, private LAN addresses), and every HTTP and WebSocket request must carry the room token
// (?t=, or the cookie set by a ?t= page load).
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

export const setCookie = (token: string, secure = false): string => `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

/** An IPv4-mapped IPv6 address (::ffff:192.168.0.2) as plain IPv4. */
export const plainAddress = (addr: string): string => addr.replace(/^::ffff:(?=\d+\.)/i, '');

export const isLoopback = (addr: string): boolean => addr === '::1' || plainAddress(addr).startsWith('127.');

/** RFC 1918: the addresses a home or office LAN hands out. */
export const isPrivateLan = (addr: string): boolean => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+(\.\d+)?$/.test(addr);

/** Adapters of VMs, containers and VPNs: no LAN device reaches them, and some change address every boot. */
const VIRTUAL = /wsl|default switch|docker|^br-|^veth|virbr|vmware|vmnet|vbox|virtualbox|zerotier/i;

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/** This machine's private IPv4 addresses on real network adapters. */
export function lanAddresses(ifaces: Interfaces = os.networkInterfaces()): string[] {
  return [...new Set(Object.entries(ifaces).filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? []).filter((i) => !i.internal && isPrivateLan(i.address)).map((i) => i.address))];
}

/** Tailscale hands out addresses from 100.64.0.0/10 (and fd7a:115c:a1e0::/48 for IPv6). */
export function isTailnet(addr: string): boolean {
  if (addr.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  const m = /^100\.(\d+)\./.exec(addr);
  return !!m && +m[1] >= 64 && +m[1] <= 127;
}

/** localhost + every tailnet address (+ `lan` ones); $BIND (comma-separated) overrides, e.g. BIND=0.0.0.0. */
export function bindAddresses(lan = false): string[] {
  const env = process.env.BIND?.trim();
  if (env) return env.split(',').map((s) => s.trim()).filter(Boolean);
  const tail = Object.values(os.networkInterfaces()).flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && isTailnet(i.address))
    .map((i) => i.address);
  return [...new Set(['127.0.0.1', ...tail, ...(lan ? lanAddresses() : [])])];
}

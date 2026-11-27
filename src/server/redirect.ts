// Where a plain-HTTP request belongs instead. localhost stays on http (dev, e2e, and `tailscale serve`,
// which terminates TLS and proxies to 127.0.0.1); every other device is sent to https.
import type { IncomingMessage } from 'node:http';
import { isLoopback, isPrivateLan, plainAddress } from './auth.ts';

export interface RedirectTargets {
  /** $EINKLANG_PUBLIC_URL, e.g. the `tailscale serve` URL; without a trailing slash. */
  publicUrl?: string;
  /** This server's own HTTPS listener, when it has one. */
  https?: {
    port: number;
    /** Host name the main certificate is for (the ts.net name). */
    name?: string;
    /** Names and addresses in the self-signed LAN certificate ($EINKLANG_LAN). */
    lanNames?: string[];
  };
}

export interface PlainRequest { remoteAddress?: string; localAddress?: string; host?: string; url?: string }

export const plainRequest = (req: IncomingMessage): PlainRequest => ({ remoteAddress: req.socket.remoteAddress, localAddress: req.socket.localAddress, host: req.headers.host, url: req.url });

/** Host name of a Host header (IPv6 in brackets), or null if it is anything else. */
function hostName(header: string | undefined): string | null {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(:\d+)?$/i.exec(header ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** Path and query as requested (`?t=` included). */
function pathAndQuery(url = '/'): string {
  if (url.startsWith('/')) return url;
  try { const u = new URL(url); return u.pathname.startsWith('/') ? u.pathname + u.search : '/'; } catch { return '/'; }
}

/**
 * The https URL to send a plain-HTTP request to, or null to serve it as it is. `redirectOnly` is for the
 * $EINKLANG_HTTP_PORT listener, which serves nothing itself, not even to localhost.
 */
export function redirectTarget(r: PlainRequest, t: RedirectTargets, redirectOnly = false): string | null {
  if (!redirectOnly && isLoopback(r.remoteAddress ?? '')) return null;
  const local = plainAddress(r.localAddress ?? ''), asked = hostName(r.host);
  const own = local.includes(':') ? `[${local}]` : local;
  const { https, publicUrl } = t;
  let base: string | null = null;
  // a LAN device may have no Tailscale: keep it on the address it can reach, with the LAN certificate
  if (https?.lanNames && isPrivateLan(local)) base = `https://${asked && https.lanNames.includes(asked) ? asked : own}:${https.port}`;
  else if (publicUrl) base = publicUrl;
  else if (https) {
    const name = https.name ?? (https.lanNames && !(asked && https.lanNames.includes(asked)) ? own : asked ?? own);
    base = name ? `https://${name}:${https.port}` : null;
  }
  return base && base + pathAndQuery(r.url);
}

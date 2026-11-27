// The server's HTTPS settings from the environment (see README "HTTPS").
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isPrivateLan, lanAddresses } from './auth.ts';
import { expiresAt, findTailscale, lanCert, needsRenewal, readCert, tailscaleCert, run, type Cert, type Exec, type Names } from './certs.ts';

export const HTTPS_PORT = 8444;

export interface CertSource { current: Cert; load(): Cert | Promise<Cert> }

export interface HttpsSetup {
  port: number;
  /** $EINKLANG_CERT/_KEY, else the Tailscale certificate. */
  main?: CertSource;
  /** Self-signed, for $EINKLANG_LAN. */
  lan?: CertSource;
  /** Host name `main` is for. */
  name?: string;
  /** What `lan` covers (without localhost). */
  lanNames?: string[];
}

function portOf(env: string, v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${env}: not a port: ${v}`);
  return n;
}

/** $EINKLANG_PUBLIC_URL without its trailing slash. */
export function publicUrl(env: NodeJS.ProcessEnv): string | undefined {
  const v = env.EINKLANG_PUBLIC_URL?.trim();
  if (!v) return undefined;
  const u = URL.parse(v);
  if (u?.protocol !== 'https:' || u.search || u.hash) throw new Error(`EINKLANG_PUBLIC_URL must be a plain https:// URL, not ${v}`);
  return u.href.replace(/\/+$/, '');
}

export function httpPort(env: NodeJS.ProcessEnv): number | undefined {
  return env.EINKLANG_HTTP_PORT ? portOf('EINKLANG_HTTP_PORT', env.EINKLANG_HTTP_PORT) : undefined;
}

export const lanEnabled = (env: NodeJS.ProcessEnv): boolean => env.EINKLANG_LAN === '1';

/** Names for the LAN certificate: this machine's names and private addresses. */
export function lanCertNames(ips: string[] = lanAddresses(), host: string = os.hostname()): Names {
  const h = host.toLowerCase();
  const dns = /^[a-z0-9._-]+$/.test(h) ? [...new Set([h, h.endsWith('.local') ? h : `${h.split('.')[0]}.local`])] : [];
  return { dns: [...dns, 'localhost'], ips: [...ips.filter(isPrivateLan), '127.0.0.1'] };
}

/**
 * What the HTTPS listener needs, or null for none ($EINKLANG_HTTPS=0, or no certificate to be had).
 * A broken $EINKLANG_CERT/_KEY throws; Tailscale trouble only warns.
 */
export async function httpsSetup(env: NodeJS.ProcessEnv, root: string, o: { exec?: Exec; warn?: (s: string) => void; names?: Names; now?: () => number } = {}): Promise<HttpsSetup | null> {
  if (env.EINKLANG_HTTPS === '0') return null;
  const warn = o.warn ?? console.warn, now = o.now ?? Date.now, dir = path.join(root, '.einklang-certs');
  const setup: HttpsSetup = { port: portOf('EINKLANG_HTTPS_PORT', env.EINKLANG_HTTPS_PORT || String(HTTPS_PORT)) };
  const certFile = env.EINKLANG_CERT, keyFile = env.EINKLANG_KEY;
  if (certFile || keyFile) {
    if (!certFile || !keyFile) throw new Error('set both EINKLANG_CERT and EINKLANG_KEY');
    const load = () => {
      const c = readCert(certFile, keyFile);
      if (!c) throw new Error(`EINKLANG_CERT/_KEY: cannot read a matching certificate and key from ${certFile} and ${keyFile}`);
      if (needsRenewal(c, now())) warn(`${certFile} expires ${new Date(expiresAt(c.cert)).toISOString()}: renew it`);
      return c;
    };
    setup.main = { current: load(), load };
    const alt = new crypto.X509Certificate(setup.main.current.cert).subjectAltName;
    setup.name = /DNS:([a-z0-9.-]+)(,|$)/i.exec(alt ?? '')?.[1];
  } else {
    try {
      const exec = o.exec ?? run, ts = await findTailscale(exec);
      if (ts) {
        const load = () => tailscaleCert(dir, ts, { exec, now: now(), log: warn });
        setup.main = { current: await load(), load };
        setup.name = ts.name;
      }
    } catch (e) { warn(`no Tailscale certificate: ${(e as Error).message}`); }
  }
  if (lanEnabled(env)) {
    // names are fixed per run: the server listens on the addresses it found at start
    const names = o.names ?? lanCertNames();
    if (names.ips.length < 2) warn('EINKLANG_LAN=1 but this machine has no private LAN address');
    const load = () => lanCert(dir, names, now());
    setup.lan = { current: load(), load };
    setup.lanNames = [...names.dns, ...names.ips].filter((n) => n !== 'localhost' && n !== '127.0.0.1');
  }
  return setup.main || setup.lan ? setup : null;
}

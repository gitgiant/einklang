// TLS certificates for the server's own HTTPS listener: files named by $EINKLANG_CERT/_KEY, else
// `tailscale cert` for this machine's ts.net name, plus (with $EINKLANG_LAN) a self-signed one for LAN
// devices without Tailscale. Checked at start and daily.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86_400_000;
export const RENEW_BEFORE_MS = 14 * DAY;
export const CHECK_EVERY_MS = DAY;
/** Longest lifetime iOS accepts for a certificate the user trusts by hand. */
const SELF_SIGNED_DAYS = 825;

export interface Cert { cert: string; key: string }

/** The certificate at `certFile` + `keyFile`, or null if either is missing or they don't belong together. */
export function readCert(certFile: string, keyFile: string): Cert | null {
  try {
    const c = { cert: fs.readFileSync(certFile, 'utf8'), key: fs.readFileSync(keyFile, 'utf8') };
    return new crypto.X509Certificate(c.cert).checkPrivateKey(crypto.createPrivateKey(c.key)) ? c : null;
  } catch { return null; }
}

export const expiresAt = (cert: string): number => Date.parse(new crypto.X509Certificate(cert).validTo);
export const fingerprint = (cert: string): string => new crypto.X509Certificate(cert).fingerprint256;
export const needsRenewal = (c: Cert | null, now: number): boolean => !c || expiresAt(c.cert) - now < RENEW_BEFORE_MS;

// --- tailscale ---

/** Runs a program to its end and returns its stdout; a missing program rejects with code 'ENOENT'. */
export type Exec = (file: string, args: string[]) => Promise<string>;

export const run: Exec = (file, args) => new Promise((ok, fail) => {
  execFile(file, args, { timeout: 60_000, windowsHide: true }, (e, stdout, stderr) => {
    if (!e) return ok(stdout);
    fail(Object.assign(new Error(stderr.trim() || e.message), { code: e.code }));
  });
});

const TAILSCALE: Record<string, string[]> = {
  win32: ['tailscale.exe', 'C:\\Program Files\\Tailscale\\tailscale.exe'],
  darwin: ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'],
};

/** The tailscale program and this machine's ts.net name; null if Tailscale isn't installed. */
export async function findTailscale(exec: Exec = run, platform: string = process.platform): Promise<{ bin: string; name: string } | null> {
  for (const bin of TAILSCALE[platform] ?? ['tailscale']) {
    let out: string;
    try { out = await exec(bin, ['status', '--json']); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    const name = String(JSON.parse(out).Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name)) throw new Error('tailscale status has no DNS name for this machine (MagicDNS off, or logged out?)');
    return { bin, name };
  }
  return null;
}

/**
 * The certificate for `ts.name` in `dir`, fetched with `tailscale cert` when it is missing or expires
 * within RENEW_BEFORE_MS. A failed renewal keeps the old one; with none to keep it throws.
 */
export async function tailscaleCert(dir: string, ts: { bin: string; name: string }, o: { exec?: Exec; now?: number; log?: (s: string) => void } = {}): Promise<Cert> {
  const certFile = path.join(dir, `${ts.name}.crt`), keyFile = path.join(dir, `${ts.name}.key`);
  const old = readCert(certFile, keyFile), now = o.now ?? Date.now();
  if (!needsRenewal(old, now)) return old!;
  try {
    fs.mkdirSync(dir, { recursive: true });
    await (o.exec ?? run)(ts.bin, ['cert', '--cert-file', certFile, '--key-file', keyFile, ts.name]);
    const fresh = readCert(certFile, keyFile);
    if (!fresh) throw new Error('it wrote no usable certificate');
    return fresh;
  } catch (e) {
    const why = `tailscale cert ${ts.name} failed: ${(e as Error).message}`;
    if (!old) throw new Error(why);
    (o.log ?? console.warn)(`${why}; keeping the certificate that expires ${new Date(expiresAt(old.cert)).toISOString()}`);
    return old;
  }
}

// --- self-signed (LAN) ---

/** One DER element. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts), n = body.length;
  const len = n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 255];
  return Buffer.concat([Buffer.from([tag, ...len]), body]);
}
const seq = (...p: Buffer[]) => der(0x30, ...p);
const hex = (s: string) => Buffer.from(s, 'hex');
const bits = (b: Buffer) => der(0x03, Buffer.from([0]), b);
const time = (ms: number) => { // UTCTime up to 2049, then GeneralizedTime
  const s = new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  return s < '2050' ? der(0x17, Buffer.from(s.slice(2))) : der(0x18, Buffer.from(s));
};
const ext = (oid: string, value: Buffer, critical = false) => seq(hex(oid), ...(critical ? [hex('0101ff')] : []), der(0x04, value));

export interface Names { dns: string[]; ips: string[] }

/** A fresh P-256 server certificate for these DNS names and IPv4 addresses, signed by its own key. */
export function selfSigned(names: Names, now: number = Date.now(), days = SELF_SIGNED_DAYS): Cert {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const alg = seq(hex('06082a8648ce3d040302')); // ecdsa-with-SHA256
  const name = seq(der(0x31, seq(hex('0603550403'), der(0x0c, Buffer.from('einklang LAN'))))); // CN
  const serial = crypto.randomBytes(16); serial[0] = (serial[0] & 0x3f) | 0x40;
  const san = seq(...names.dns.map((d) => der(0x82, Buffer.from(d))), ...names.ips.map((ip) => der(0x87, Buffer.from(ip.split('.').map(Number)))));
  const tbs = seq(
    der(0xa0, hex('020102')), der(0x02, serial), alg, name, seq(time(now - DAY), time(now - DAY + days * DAY)), name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, seq(
      ext('0603551d13', seq(), true), // basicConstraints: not a CA
      ext('0603551d0f', hex('03020780'), true), // keyUsage: digitalSignature
      ext('0603551d25', seq(hex('06082b06010505070301'))), // extKeyUsage: serverAuth
      ext('0603551d11', san),
    )),
  );
  const body = seq(tbs, alg, bits(crypto.sign('sha256', tbs, privateKey))).toString('base64');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  };
}

/**
 * The LAN certificate in `dir`. Generated once, so its fingerprint stays; replaced only when it lacks one
 * of `names` (a new address) or is about to expire.
 */
export function lanCert(dir: string, names: Names, now: number = Date.now()): Cert & { created: boolean } {
  const certFile = path.join(dir, 'lan.crt'), keyFile = path.join(dir, 'lan.key');
  const old = readCert(certFile, keyFile);
  if (old && !needsRenewal(old, now)) {
    const x = new crypto.X509Certificate(old.cert);
    if (names.dns.every((d) => x.checkHost(d)) && names.ips.every((ip) => x.checkIP(ip))) return { ...old, created: false };
  }
  const c = selfSigned(names, now);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyFile, c.key, { mode: 0o600 });
  fs.writeFileSync(certFile, c.cert);
  return { ...c, created: true };
}

// --- renewal ---

export interface Timers { every(f: () => void, ms: number): () => void }
const realTimers: Timers = { every: (f, ms) => { const t = setInterval(f, ms); t.unref(); return () => clearInterval(t); } };

/**
 * Every CHECK_EVERY_MS, `load` the certificate again and `apply` it if it changed. A failure is logged and
 * the certificate in use stays. Returns a stop function.
 */
export function keepFresh(current: Cert, load: () => Cert | Promise<Cert>, apply: (c: Cert) => void, o: { timers?: Timers; log?: (s: string) => void } = {}): () => void {
  let have = current, busy = false;
  return (o.timers ?? realTimers).every(async () => {
    if (busy) return;
    busy = true;
    try {
      const c = await load();
      if (c.cert !== have.cert || c.key !== have.key) { apply(c); have = c; (o.log ?? console.log)(`new TLS certificate, expires ${new Date(expiresAt(c.cert)).toISOString()}`); }
    } catch (e) { (o.log ?? console.warn)(`TLS certificate check failed: ${(e as Error).message}`); }
    busy = false;
  }, CHECK_EVERY_MS);
}

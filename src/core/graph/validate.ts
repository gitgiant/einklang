// Validation of piece manifests and scene graphs, plus the evaluation order. Pure, no GPU.
import { CPU_PORTS, PIECE_KINDS, PORT_TYPES, isTexPort, type ParamSpec, type PieceManifest, type PortSpec } from '../../../lab/api/index.ts';
import { splitRef, type PieceDef, type Registry, type SceneGraph } from './types.ts';
import { POST_KEYS } from '../post.ts';

const ID = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const NAME = /^[a-z_][a-z0-9_]*$/;
/** Input types an auto-shader piece can bind (textures + the palette uniform). */
const AUTO_IN = new Set(['tex', 'mask', 'field', 'palette']);

const ports = (m: PieceManifest, dir: 'in' | 'out'): Record<string, PortSpec> => (dir === 'in' ? m.ports.in ?? {} : m.ports.out);

function checkParam(name: string, p: ParamSpec, err: (s: string) => void): void {
  const t = p.type, d = p.default;
  if (!['float', 'int', 'bool', 'enum', 'color', 'text'].includes(t)) return err(`param ${name}: unknown type ${t}`);
  if (t === 'float' || t === 'int') {
    if (typeof d !== 'number' || !Number.isFinite(d)) return err(`param ${name}: default must be a number`);
    if (p.min === undefined || p.max === undefined || !(p.min < p.max)) return err(`param ${name}: needs min < max`);
    if (d < p.min || d > p.max) err(`param ${name}: default ${d} outside [${p.min}, ${p.max}]`);
    if (t === 'int' && !Number.isInteger(d)) err(`param ${name}: int default must be an integer`);
  } else if (t === 'bool') { if (typeof d !== 'boolean') err(`param ${name}: default must be a boolean`); }
  else if (t === 'enum') {
    if (!p.options?.length) return err(`param ${name}: enum needs options`);
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d >= p.options.length) err(`param ${name}: enum default must be an option index`);
  } else if (t === 'color') { if (typeof d !== 'string' || !/^#[0-9a-f]{6}$/i.test(d)) err(`param ${name}: color default must be #rrggbb`); }
  else if (typeof d !== 'string') err(`param ${name}: text default must be a string`);
}

/** Problems with a piece (empty = valid). `folder` is the piece's directory name, which must equal its id. */
export function validatePiece(def: PieceDef, folder?: string): string[] {
  const m = def.manifest, errs: string[] = [], err = (s: string) => errs.push(`${m.id ?? '?'}: ${s}`);
  if (typeof m.id !== 'string' || !ID.test(m.id)) err('id must be <vendor>-<slug> (lowercase, dashes)');
  if (folder !== undefined && folder !== m.id) err(`folder ${folder} must match id`);
  if (!PIECE_KINDS.includes(m.kind)) err(`unknown kind ${m.kind}`);
  if (!m.name) err('name required');
  if (!m.author?.vendor) err('author.vendor required');
  if (!m.ports?.out || !Object.keys(m.ports.out).length) err('needs at least one output port');
  for (const dir of ['in', 'out'] as const) {
    for (const [n, p] of Object.entries(ports(m, dir))) {
      if (!NAME.test(n)) err(`${dir} port ${n}: names are lower_snake`);
      if (!PORT_TYPES.includes(p.type)) err(`${dir} port ${n}: unknown type ${p.type}`);
    }
  }
  for (const [n, p] of Object.entries(m.params ?? {})) { if (!NAME.test(n)) err(`param ${n}: names are lower_snake`); checkParam(n, p, err); }
  const outs = Object.entries(m.ports?.out ?? {});
  const d = def.driver;
  if (m.shader) {
    if (d) err('a piece has either shader (auto) or driver.ts, not both');
    if (!(m.shader in def.wgsl)) err(`shader file ${m.shader} missing`);
    else if (!/fn\s+shade\s*\(/.test(def.wgsl[m.shader])) err(`${m.shader} must define fn shade(uv: vec2f) -> vec4f`);
    if (outs.length !== 1 || !isTexPort(outs[0][1].type)) err('auto-shader pieces have exactly one tex/mask/field output');
    for (const [n, p] of Object.entries(ports(m, 'in'))) if (!AUTO_IN.has(p.type)) err(`auto-shader input ${n}: ${p.type} not supported (use bindings for signals)`);
    if (Object.values(ports(m, 'in')).filter((p) => p.type === 'palette').length > 1) err('at most one palette input');
  } else {
    if (!d) err('needs shader (auto) or driver.ts');
    else {
      if (!d.cpu && !d.gpu) err('driver needs cpu() or gpu()');
      for (const [n, p] of outs) {
        if (CPU_PORTS.includes(p.type) && !d.cpu) err(`output ${n} (${p.type}) needs cpu()`);
        if (!CPU_PORTS.includes(p.type) && !d.gpu) err(`output ${n} (${p.type}) needs gpu()`);
      }
    }
  }
  if (m.feedback && !m.shader) err('feedback is for auto-shader pieces (drivers keep their own textures)');
  for (const a of m.assets ?? []) if (!a.license) err(`asset ${a.path}: license required`);
  return errs;
}

/** Problems with a scene against the registry (empty = valid). */
export function validateScene(g: SceneGraph, reg: Registry): string[] {
  const errs: string[] = [], err = (s: string) => errs.push(`${g.id ?? '?'}: ${s}`);
  if (g.format !== 1) err('format must be 1');
  // the v1 scenes keep their original ids (radial, tunnel, scope, flow)
  if (typeof g.id !== 'string' || !(ID.test(g.id) || (g.author?.vendor === 'core' && /^[a-z0-9]+$/.test(g.id)))) err('id must be <vendor>-<slug>');
  for (const [k, v] of Object.entries(g.post ?? {})) {
    if (!(POST_KEYS as string[]).includes(k)) err(`post: unknown key ${k}`);
    else if (typeof v !== 'number' || !Number.isFinite(v)) err(`post.${k} must be a number`);
  }
  if (!g.name) err('name required');
  if (!Number.isInteger(g.version) || g.version < 1) err('version must be an integer >= 1');
  if (!g.author?.vendor) err('author.vendor required');
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) { err('nodes and edges must be arrays'); return errs; }
  const nodes = new Map<string, PieceManifest>();
  for (const n of g.nodes) {
    if (!NAME.test(n.id)) err(`node ${n.id}: ids are lower_snake`);
    if (nodes.has(n.id)) err(`node ${n.id}: duplicate id`);
    const p = reg.get(n.piece);
    if (!p) { err(`node ${n.id}: unknown piece ${n.piece}`); continue; }
    nodes.set(n.id, p.manifest);
    const specs = p.manifest.params ?? {};
    for (const [k, v] of Object.entries(n.params ?? {})) {
      const s = specs[k];
      if (!s) { err(`node ${n.id}: unknown param ${k}`); continue; }
      const num = s.type === 'float' || s.type === 'int' || s.type === 'enum';
      if (num && (typeof v !== 'number' || !Number.isFinite(v))) err(`node ${n.id}: param ${k} must be a number`);
      else if (s.type === 'bool' && typeof v !== 'boolean') err(`node ${n.id}: param ${k} must be a boolean`);
      else if ((s.type === 'color' || s.type === 'text') && typeof v !== 'string') err(`node ${n.id}: param ${k} must be a string`);
      else if ((s.type === 'float' || s.type === 'int') && ((v as number) < s.min! || (v as number) > s.max!)) err(`node ${n.id}: param ${k}=${v} outside [${s.min}, ${s.max}]`);
      else if (s.type === 'enum' && ((v as number) < 0 || (v as number) >= s.options!.length)) err(`node ${n.id}: param ${k} is not an option index`);
    }
  }
  const outPort = (ref: string) => {
    const [nid, port] = splitRef(ref), m = nodes.get(nid);
    return m ? m.ports.out[port] : undefined;
  };
  for (const n of g.nodes) {
    const m = nodes.get(n.id);
    if (!m) continue;
    for (const [k, b] of Object.entries(n.bind ?? {})) {
      const s = m.params?.[k];
      if (!s) { err(`node ${n.id}: bind to unknown param ${k}`); continue; }
      if (s.type !== 'float' && s.type !== 'int') err(`node ${n.id}: only float/int params can be bound (${k} is ${s.type})`);
      const src = outPort(b.from);
      if (!src) err(`node ${n.id}: bind ${k} from unknown output ${b.from}`);
      else if (src.type !== 'signal') err(`node ${n.id}: bind ${k} needs a signal, ${b.from} is ${src.type}`);
      if (b.range && (b.range.length !== 2 || !b.range.every(Number.isFinite))) err(`node ${n.id}: bind ${k} range must be [lo, hi]`);
    }
  }
  const fed = new Set<string>();
  for (const e of g.edges) {
    const src = outPort(e.from), [tn, tp] = splitRef(e.to), tm = nodes.get(tn), dst = tm?.ports.in?.[tp];
    if (!src) err(`edge ${e.from} -> ${e.to}: unknown output ${e.from}`);
    if (!dst) err(`edge ${e.from} -> ${e.to}: unknown input ${e.to}`);
    if (src && dst && src.type !== dst.type) err(`edge ${e.from} -> ${e.to}: ${src.type} into ${dst.type}`);
    if (fed.has(e.to)) err(`input ${e.to} has more than one edge`);
    fed.add(e.to);
  }
  for (const n of g.nodes) {
    for (const [p, s] of Object.entries(nodes.get(n.id)?.ports.in ?? {})) if (!s.optional && !fed.has(`${n.id}.${p}`)) err(`input ${n.id}.${p} is not connected`);
  }
  const o = outPort(g.out);
  if (!o) err(`out ${g.out} is not an output`);
  else if (o.type !== 'tex') err(`out ${g.out} must be tex, is ${o.type}`);
  if (!errs.length && order(g) === null) err('graph has a cycle');
  return errs;
}

/** Dependencies of each node: edge sources and binding sources. */
export function deps(g: SceneGraph): Map<string, Set<string>> {
  const d = new Map(g.nodes.map((n) => [n.id, new Set<string>()]));
  for (const e of g.edges) d.get(splitRef(e.to)[0])?.add(splitRef(e.from)[0]);
  for (const n of g.nodes) for (const b of Object.values(n.bind ?? {})) d.get(n.id)?.add(splitRef(b.from)[0]);
  return d;
}

/**
 * Evaluation order: the nodes the output depends on, dependencies first (stable: ties keep
 * file order). Null when there is a cycle.
 */
export function order(g: SceneGraph): string[] | null {
  const d = deps(g), need = new Set<string>(), stack = [splitRef(g.out)[0]];
  while (stack.length) { const n = stack.pop()!; if (need.has(n) || !d.has(n)) continue; need.add(n); stack.push(...d.get(n)!); }
  const out: string[] = [], state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    const s = state.get(n);
    if (s === 2) return true;
    if (s === 1) return false;
    state.set(n, 1);
    for (const m of d.get(n)!) if (!visit(m)) return false;
    state.set(n, 2); out.push(n);
    return true;
  };
  for (const n of g.nodes) if (need.has(n.id) && !visit(n.id)) return null;
  // a cycle among nodes the output doesn't need is still a broken scene
  for (const n of g.nodes) if (!need.has(n.id) && !visit(n.id)) return null;
  return out.filter((n) => need.has(n));
}

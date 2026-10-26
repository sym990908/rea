// City and knot: a slowly moving 3D rebuild of the paper's hero illustration.
// Left, a city on an island, cut by a river. Right, the same city paved onto a
// torus knot of aqueducts. Everything is procedural and seeded, so every load
// draws the same scene. The knot is not rotated as a whole: its strands swell,
// breathe apart and roll a little, each on its own schedule, computed in the
// vertex shader. Trains run, boats drift, the water moves. A final pass inks
// the silhouettes and lays the render on paper.

import * as THREE from './three.module.min.js';

const TAU = Math.PI * 2;
const Z2 = [0, 0];

// ------------------------------------------------------------ randomness

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(1);
let bStream = mulberry32(2); // buildings draw their details from a stream of their own
const reseed = (s) => { rand = mulberry32(s); bStream = mulberry32(s + 101); };
const rnd = (a = 0, b = 1) => a + (b - a) * rand();
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

function hash2(i, j) {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y, oct = 4) {
  let s = 0, amp = 0.5, f = 1, n = 0;
  for (let k = 0; k < oct; k++) { s += amp * vnoise(x * f, y * f); n += amp; f *= 2.03; amp *= 0.5; }
  return s / n;
}
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------ vectors & colour

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const col = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const jit = (c, amt = 0.07) => shade(c, 1 + (rand() * 2 - 1) * amt);

// Palette sampled by eye from the painted original: washed terracotta, cream
// and bone walls, sage greens, blue-grey glass, warm grey stone.
const PAL = {
  walls: ['#f3ede2', '#eee6d6', '#e8decb', '#f6f3ed', '#ecdfd0', '#e3d7c3', '#e7e4dd', '#dedbd4', '#eae3d6', '#d9d4ca'],
  roofs: ['#c78469', '#d19479', '#bb7662', '#d6a58c', '#c48b72', '#b9735f', '#cd9a80', '#c07d66'],
  flat: ['#d6cfc3', '#ddd7cc', '#cbc4b8', '#d2cbc0'],
  glass: ['#93aab2', '#a1b6bc', '#86a0aa', '#aec0c3', '#8fa6ad', '#7f97a1'],
  stoneTower: ['#e3dccf', '#d8d0c1', '#e9e3d8', '#d2c9b9'],
  trees: ['#687e52', '#76895c', '#839565', '#5a7047', '#8c9b6e', '#627a4c', '#97a579', '#52683f', '#7a8f5e'],
  ground: '#e7e2d5', park: '#b6c090', bank: '#a9b687', road: '#c5c8c7', stone: '#cdc6b8', deck: '#d2ccc0', lane: '#aca9a2',
  stoneDark: '#aca290', rock: '#c2beb4', water: '#7d9fa6', slate: '#7d878d', copper: '#98b6a8',
  brick: '#b9806c', canal: '#587d82', train: '#f0ebe1',
  warmWalls: ['#ebd3a4', '#efdcaa', '#eccfc2', '#e2b394', '#efdcc0', '#e6c697'], // ochre, yellow, pink, terracotta
};
// list entries become linear-RGB triples; single entries stay hex for col()
for (const k of Object.keys(PAL)) if (Array.isArray(PAL[k])) PAL[k] = PAL[k].map(col);

// ------------------------------------------------------------ geometry builder
// Geometry is authored in a local frame and pushed through a warp W, which maps
// local points (and normals) to the parent frame. For the city W is the
// identity; viaducts bend a straight street onto a curve. The knot is left in
// street coordinates (u, height, across) and bent on the GPU every frame.

const ID = { p: (x, y, z) => [x, y, z], n: (x, y, z, a, b, c) => [a, b, c] };

// Growable Float32Array, so a few hundred thousand triangles build quickly.
class Buf {
  constructor(n = 1 << 16) { this.a = new Float32Array(n); this.length = 0; }
  grow(k) { if (this.length + k > this.a.length) { const b = new Float32Array(Math.max(this.a.length * 2, this.length + k)); b.set(this.a); this.a = b; } }
  push3(x, y, z) { this.grow(3); const a = this.a; a[this.length++] = x; a[this.length++] = y; a[this.length++] = z; }
  array() { return this.a.subarray(0, this.length); }
}

class Geo {
  constructor() { this.P = new Buf(); this.N = new Buf(); this.C = new Buf(); this.S = new Buf(); this.U = new Buf(); this.L = new Buf(); this.crowns = []; }
  vert(W, p, n, c, s, u) {
    const q = W.p(p[0], p[1], p[2]), m = W.n(p[0], p[1], p[2], n[0], n[1], n[2]);
    this.P.push3(q[0], q[1], q[2]); this.N.push3(m[0], m[1], m[2]); this.C.push3(c[0], c[1], c[2]);
    this.S.grow(1); this.S.a[this.S.length++] = s;
    this.U.grow(2); this.U.a[this.U.length++] = u[0]; this.U.a[this.U.length++] = u[1];
  }
  tri(W, a, b, c, colr, st, ua = Z2, ub = Z2, uc = Z2, ref = null) {
    let n = cross(sub(b, a), sub(c, a));
    if (len3(n) < 1e-14) return;
    n = norm(n);
    if (ref) {
      const ctr = scl(add(add(a, b), c), 1 / 3);
      if (dot(n, sub(ctr, ref)) < 0) { [b, c] = [c, b]; [ub, uc] = [uc, ub]; n = scl(n, -1); }
    }
    this.vert(W, a, n, colr, st, ua); this.vert(W, b, n, colr, st, ub); this.vert(W, c, n, colr, st, uc);
  }
  // A triangle with its own normal and colour at each corner (smooth shading).
  triN(W, a, b, c, na, nb, nc, ca, cb, cc, st, ua = Z2, ub = Z2, uc = Z2) {
    const fn = cross(sub(b, a), sub(c, a));
    if (len3(fn) < 1e-14) return;
    if (dot(fn, add(add(na, nb), nc)) < 0) { [b, c] = [c, b]; [nb, nc] = [nc, nb]; [cb, cc] = [cc, cb]; [ub, uc] = [uc, ub]; }
    this.vert(W, a, na, ca, st, ua); this.vert(W, b, nb, cb, st, ub); this.vert(W, c, nc, cc, st, uc);
  }
  quad(W, a, b, c, d, colr, st, ua = Z2, ub = Z2, uc = Z2, ud = Z2, ref = null) {
    let n = cross(sub(b, a), sub(c, a));
    if (len3(n) < 1e-14) n = cross(sub(c, a), sub(d, a));
    if (len3(n) < 1e-14) return;
    n = norm(n);
    if (ref) {
      const ctr = scl(add(add(a, b), add(c, d)), 0.25);
      if (dot(n, sub(ctr, ref)) < 0) { [b, d] = [d, b]; [ub, ud] = [ud, ub]; n = scl(n, -1); }
    }
    this.vert(W, a, n, colr, st, ua); this.vert(W, b, n, colr, st, ub); this.vert(W, c, n, colr, st, uc);
    this.vert(W, a, n, colr, st, ua); this.vert(W, c, n, colr, st, uc); this.vert(W, d, n, colr, st, ud);
  }
  seg(W, a, b) { const p = W.p(a[0], a[1], a[2]), q = W.p(b[0], b[1], b[2]); this.L.push3(p[0], p[1], p[2]); this.L.push3(q[0], q[1], q[2]); }
  get tris() { return this.P.length / 9; }
  mesh(material) {
    const n = this.P.length / 3, src = [[this.P, 3], [this.N, 3], [this.C, 3], [this.S, 1], [this.U, 2]];
    const bits = src.map(([b]) => new Uint32Array(b.a.buffer, 0, b.length));
    const slot = new Int32Array(1 << Math.ceil(Math.log2(2 * n + 2))).fill(-1), mask = slot.length - 1;
    const index = new Uint32Array(n), first = new Int32Array(n);
    let unique = 0;
    const same = (i, j) => src.every(([, k], a) => { for (let c = 0; c < k; c++) if (bits[a][i * k + c] !== bits[a][j * k + c]) return false; return true; });
    for (let i = 0; i < n; i++) {
      let h = 2166136261;
      for (let a = 0; a < 5; a++) { const k = src[a][1]; for (let c = 0; c < k; c++) h = Math.imul(h ^ bits[a][i * k + c], 16777619); }
      let at = h & mask;
      while (slot[at] >= 0 && !same(first[slot[at]], i)) at = (at + 1) & mask;
      if (slot[at] < 0) { slot[at] = unique; first[unique++] = i; }
      index[i] = slot[at];
    }
    const g = new THREE.BufferGeometry();
    for (const [name, [b, k]] of [['position', src[0]], ['normal', src[1]], ['color', src[2]], ['aStyle', src[3]], ['aWall', src[4]]]) {
      const out = new Float32Array(unique * k);
      for (let u = 0; u < unique; u++) for (let c = 0; c < k; c++) out[u * k + c] = b.a[first[u] * k + c];
      g.setAttribute(name, new THREE.BufferAttribute(out, k));
    }
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const m = new THREE.Mesh(g, material);
    m.castShadow = true; m.receiveShadow = true;
    return m;
  }
  lines(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.L.array(), 3));
    return new THREE.LineSegments(g, material);
  }
}

// Object transform: rotate about the local up axis, then translate.
function X(cx, y0, cz, rot = 0) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return (x, y, z) => [cx + x * c - z * s, y0 + y, cz + x * s + z * c];
}

// ------------------------------------------------------------ primitives
// Styles (read by the shader): 0 plain, 1 punched windows, 2 curtain wall,
// 3 ground, 4 dressed stone, 5 roof tiles, 6 rock.

function box(g, W, f, sx, sy, sz, o) {
  const x0 = -sx / 2, x1 = sx / 2, z0 = -sz / 2, z1 = sz / 2;
  const A = f(x0, 0, z0), B = f(x1, 0, z0), C = f(x1, 0, z1), D = f(x0, 0, z1);
  const E = f(x0, sy, z0), F = f(x1, sy, z0), G = f(x1, sy, z1), H = f(x0, sy, z1);
  const ref = f(0, sy / 2, 0), v0 = o.v0 || 0;
  for (const [a, b, c, d, w] of [[A, B, F, E, sx], [B, C, G, F, sz], [C, D, H, G, sx], [D, A, E, H, sz]]) {
    g.quad(W, a, b, c, d, o.wall, o.wallSt ?? 1, [0, v0], [w, v0], [w, v0 + sy], [0, v0 + sy], ref);
  }
  if (o.top) g.quad(W, E, F, G, H, o.top, o.topSt ?? 0, [x0, z0], [x1, z0], [x1, z1], [x0, z1], ref);
  if (o.bottom) g.quad(W, A, B, C, D, o.bottom, 0, Z2, Z2, Z2, Z2, ref);
  if (o.edges !== false) {
    for (const [a, b] of [[E, F], [F, G], [G, H], [H, E], [A, E], [B, F], [C, G], [D, H]]) g.seg(W, a, b);
    if (o.baseEdges) for (const [a, b] of [[A, B], [B, C], [C, D], [D, A]]) g.seg(W, a, b);
  }
}

function hipRoof(g, W, f, sx, sz, hr, colr, gable = false, wallCol = null) {
  const o = 0.012, ex = sx / 2 + o, ez = sz / 2 + o;
  const A = f(-ex, 0, -ez), B = f(ex, 0, -ez), C = f(ex, 0, ez), D = f(-ex, 0, ez);
  const ref = f(0, -0.2, 0), uv = (p) => [0, p[1] * 3];
  let R1, R2;
  if (sx >= sz) {
    const k = gable ? ex : ex - ez;
    R1 = f(-k, hr, 0); R2 = f(k, hr, 0);
    g.quad(W, D, C, R2, R1, colr, 5, uv(D), uv(C), uv(R2), uv(R1), ref);
    g.quad(W, B, A, R1, R2, shade(colr, 0.97), 5, uv(B), uv(A), uv(R1), uv(R2), ref);
    const ec = gable ? (wallCol || colr) : colr, es = gable ? 0 : 5;
    g.tri(W, A, D, R1, ec, es, uv(A), uv(D), uv(R1), ref);
    g.tri(W, C, B, R2, ec, es, uv(C), uv(B), uv(R2), ref);
    for (const [a, b] of [[R1, R2], [A, R1], [D, R1], [B, R2], [C, R2], [A, B], [C, D]]) g.seg(W, a, b);
  } else {
    const k = gable ? ez : ez - ex;
    R1 = f(0, hr, -k); R2 = f(0, hr, k);
    g.quad(W, A, D, R2, R1, colr, 5, uv(A), uv(D), uv(R2), uv(R1), ref);
    g.quad(W, C, B, R1, R2, shade(colr, 0.97), 5, uv(C), uv(B), uv(R1), uv(R2), ref);
    const ec = gable ? (wallCol || colr) : colr, es = gable ? 0 : 5;
    g.tri(W, B, A, R1, ec, es, uv(B), uv(A), uv(R1), ref);
    g.tri(W, D, C, R2, ec, es, uv(D), uv(C), uv(R2), ref);
    for (const [a, b] of [[R1, R2], [A, R1], [B, R1], [C, R2], [D, R2], [A, D], [B, C]]) g.seg(W, a, b);
  }
}

function cylinder(g, W, f, r, h, n, side, top, st = 0, r2 = r, edges = true) {
  const ref = f(0, h / 2, 0), ctop = f(0, h, 0);
  for (let k = 0; k < n; k++) {
    const a0 = k / n * TAU, a1 = (k + 1) / n * TAU;
    const p0 = f(r * Math.cos(a0), 0, r * Math.sin(a0)), p1 = f(r * Math.cos(a1), 0, r * Math.sin(a1));
    const q0 = f(r2 * Math.cos(a0), h, r2 * Math.sin(a0)), q1 = f(r2 * Math.cos(a1), h, r2 * Math.sin(a1));
    const u0 = r * a0, u1 = r * a1;
    if (r2 > 1e-6) {
      g.quad(W, p0, p1, q1, q0, side, st, [u0, 0], [u1, 0], [u1, h], [u0, h], ref);
      if (top) g.tri(W, ctop, q0, q1, top, 0, Z2, Z2, Z2, ref);
      if (edges) g.seg(W, q0, q1);
    } else {
      g.tri(W, p0, p1, q0, side, st, [u0, 0], [u1, 0], [u0, h], ref);
    }
  }
}

function cone(g, W, f, r, h, n, colr) { cylinder(g, W, f, r, h, n, colr, null, 0, 0); }

const ICO1 = new THREE.IcosahedronGeometry(1, 1).attributes.position.array;
const ICO0 = new THREE.IcosahedronGeometry(1, 0).attributes.position.array;

// A faceted lump: rocks, a dome. Lower faces are painted darker so the lump
// reads round even in flat light.
function blob(g, W, f, r, sy, base, amt, tpl = ICO1, st = 0, under = 0.22) {
  const ref = f(0, r * sy, 0);
  for (let i = 0; i < tpl.length; i += 9) {
    const a = f(tpl[i] * r, (tpl[i + 1] + 1) * r * sy, tpl[i + 2] * r);
    const b = f(tpl[i + 3] * r, (tpl[i + 4] + 1) * r * sy, tpl[i + 5] * r);
    const c = f(tpl[i + 6] * r, (tpl[i + 7] + 1) * r * sy, tpl[i + 8] * r);
    const hy = (tpl[i + 1] + tpl[i + 4] + tpl[i + 7]) / 3;
    g.tri(W, a, b, c, shade(jit(base, amt), 1 - under * (0.5 - 0.5 * hy)), st, Z2, Z2, Z2, ref);
  }
}
// A shore boulder: pale on top, dark underneath where it sits in its own
// shadow, with moss on some upward faces, and a pen line around the part of
// its outline the camera sees. One random number per face, as blob().
const MOSS = col('#98a276');
const CITY_VIEW = norm([0.09, 0.59, 0.58]); // toward the camera, in the island's own frame
const EDGES = new Map();
function edgePairs(tpl) { // faces meeting at each edge of a template: [face, face, corner, corner]
  if (EDGES.has(tpl)) return EDGES.get(tpl);
  const key = (i) => tpl[i].toFixed(4) + ',' + tpl[i + 1].toFixed(4) + ',' + tpl[i + 2].toFixed(4), seen = new Map(), out = [];
  for (let i = 0; i < tpl.length; i += 3) {
    const f0 = i - i % 9, j = f0 + (i - f0 + 3) % 9, ka = key(i), kb = key(j), k = ka < kb ? ka + '|' + kb : kb + '|' + ka;
    if (seen.has(k)) out.push([seen.get(k), f0 / 9, i, j]); else seen.set(k, f0 / 9);
  }
  EDGES.set(tpl, out);
  return out;
}
function boulder(g, W, f, r, sy, base, amt, moss, tpl = ICO0) {
  const ref = f(0, r * sy, 0), P = [], facing = [];
  for (let i = 0; i < tpl.length; i += 3) P.push(f(tpl[i] * r, (tpl[i + 1] + 1) * r * sy, tpl[i + 2] * r));
  for (let t = 0; t < P.length; t += 3) {
    const a = P[t], b = P[t + 1], c = P[t + 2], k = t * 3;
    const hy = (tpl[k + 1] + tpl[k + 4] + tpl[k + 7]) / 3;
    const cc = shade(jit(base, amt), 0.54 + 0.4 * smooth(-0.75, 0.75, hy));
    g.tri(W, a, b, c, mixc(cc, MOSS, moss * smooth(0.3, 0.75, hy)), 6, Z2, Z2, Z2, ref);
    const n = cross(sub(b, a), sub(c, a)), ctr = scl(add(add(a, b), c), 1 / 3);
    facing.push(dot(n, CITY_VIEW) * Math.sign(dot(n, sub(ctr, ref))) > 0);
  }
  for (const [fa, fb, i, j] of edgePairs(tpl)) if (facing[fa] !== facing[fb]) g.seg(W, P[i / 3], P[j / 3]);
}
// Lumpier boulders for the outcrops: an icosahedron pushed in and out by
// noise, flattened below and a little on top.
function rockTemplate(seed, tpl = ICO0) {
  const p = tpl.slice();
  for (let i = 0; i < p.length; i += 3) {
    const k = 1 + 0.5 * (vnoise(p[i] * 1.7 + seed * 7.3, p[i + 1] * 1.7 + p[i + 2] * 1.3 + seed * 3.1) - 0.5);
    p[i] *= k; p[i + 1] *= k * (p[i + 1] < 0 ? 0.55 : 0.85); p[i + 2] *= k;
  }
  return p;
}
// Trees are drawn instanced: a few leaf-crown shapes, each placed thousands of
// times. A crown is smooth-shaded and lumpy, darker underneath, with a leaf
// texture (style 7). Builders only record where the crowns go.
const CROWN_VARIANTS = 4;
function crownTemplate(seed) {
  const g = new Geo(), tpl = ICO1;
  const bump = (x, y, z) => 1 + 0.2 * (vnoise(x * 2.1 + seed * 13.7, y * 2.1 + z * 1.7 + seed * 5.1) - 0.5);
  const P = (x, y, z) => { const k = bump(x, y, z); return [x * k, y * k + 1, z * k]; };
  const C = (x, y, z) => { const v = (1 - 0.4 * (0.5 - 0.5 * y)) * (0.93 + 0.14 * vnoise(x * 3 + seed * 7, z * 3 + y)); return [v, v, v]; };
  const U = (x, y, z) => [x * 1.7 + z * 1.1 + seed * 9.1, y * 1.9 + z * 0.6 + seed * 3.3];
  for (let i = 0; i < tpl.length; i += 9) {
    const A = [tpl[i], tpl[i + 1], tpl[i + 2]], B = [tpl[i + 3], tpl[i + 4], tpl[i + 5]], D = [tpl[i + 6], tpl[i + 7], tpl[i + 8]];
    g.triN(ID, P(...A), P(...B), P(...D), norm(A), norm(B), norm(D), C(...A), C(...B), C(...D), 7, U(...A), U(...B), U(...D));
  }
  return g.mesh(null).geometry;
}
// A short trunk under a conifer. Crowns are tinted green per instance; this
// base colour turns that tint into a warm grey-brown.
const BARK = [0.62, 0.34, 0.42];
function stem(g, r, h) {
  const n = 5;
  for (let k = 0; k < n; k++) {
    const a0 = k / n * TAU, a1 = (k + 1) / n * TAU, c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    const p = [[r * c0, 0, r * s0], [r * c1, 0, r * s1], [r * 0.7 * c1, h, r * 0.7 * s1], [r * 0.7 * c0, h, r * 0.7 * s0]];
    const n0 = [c0, 0, s0], n1 = [c1, 0, s1];
    g.triN(ID, p[0], p[1], p[2], n0, n1, n1, BARK, BARK, BARK, 0);
    g.triN(ID, p[0], p[2], p[3], n0, n1, n0, BARK, BARK, BARK, 0);
  }
}
// Conifers and cypresses are turned from a profile of (radius, height) pairs:
// tiers of drooping boughs, or one tapering flame, closing to a point. Bands
// that face down are the dark undersides of the boughs.
const CONIFER = [[0.09, 0.34], [0.2, 0.4], [1, 0.3], [0.6, 0.84], [0.82, 0.74], [0.42, 1.3], [0.6, 1.22], [0.2, 1.76], [0.34, 1.7], [0, 2.3]];
const CYPRESS = [[0.08, 0.16], [0.5, 0.22], [0.86, 0.5], [1, 0.95], [0.9, 1.4], [0.62, 1.8], [0.3, 2.12], [0, 2.3]];
function latheCrown(seed, prof, trunk) {
  const g = new Geo(), n = 10, m = prof.length;
  const R = (i, k) => prof[i][0] * (1 + 0.16 * (vnoise(i * 1.7 + seed * 5.3, (k % n) * 0.9 + seed * 2.1) - 0.5));
  const pt = (i, k) => { const a = k / n * TAU, r = R(i, k); return [r * Math.cos(a), prof[i][1], r * Math.sin(a)]; };
  for (let i = 0; i < m - 1; i++) {
    const dr = prof[i + 1][0] - prof[i][0], dy = prof[i + 1][1] - prof[i][1], l = Math.hypot(dr, dy);
    const nr = dy / l, ny = -dr / l, tone = (1 - 0.34 * (0.5 - 0.5 * ny)) * (0.84 + 0.16 * prof[i][1] / 2.3);
    for (let k = 0; k < n; k++) {
      const a0 = k / n * TAU, a1 = (k + 1) / n * TAU;
      const N0 = [nr * Math.cos(a0), ny, nr * Math.sin(a0)], N1 = [nr * Math.cos(a1), ny, nr * Math.sin(a1)];
      const A = pt(i, k), B = pt(i, k + 1), C = pt(i + 1, k + 1), D = pt(i + 1, k);
      const c = (p) => { const v = tone * (0.93 + 0.14 * vnoise(p[0] * 3 + seed * 7, p[2] * 3 + p[1] * 2)); return [v, v, v]; };
      const U = (p) => [p[0] * 1.7 + p[2] * 1.1 + seed * 9.1, p[1] * 1.9 + p[2] * 0.6 + seed * 3.3];
      g.triN(ID, A, B, C, N0, N1, N1, c(A), c(B), c(C), 7, U(A), U(B), U(C));
      g.triN(ID, A, C, D, N0, N1, N0, c(A), c(C), c(D), 7, U(A), U(C), U(D));
    }
  }
  stem(g, trunk, prof[0][1] + 0.08);
  return g.mesh(null).geometry;
}
// Instanced tree shapes: the leafy crowns, then a conifer and a cypress.
const V_CONIFER = CROWN_VARIANTS, V_CYPRESS = V_CONIFER + 1;
function treeTemplates() {
  return [...Array.from({ length: CROWN_VARIANTS }, (_, i) => crownTemplate(i + 1)), latheCrown(1, CONIFER, 0.1), latheCrown(2, CYPRESS, 0.12)];
}
// Trees are clumps: a main crown and a lobe or two, like the painted ones.
function tree(g, W, x, y0, z, r, c, small = false) {
  const put = (px, py, pz, pr, sy, pc) => g.crowns.push({ W, x: px, y: py, z: pz, r: pr, sy, rot: rnd(0, TAU), c: pc, v: Math.floor(rand() * CROWN_VARIANTS) });
  const n0 = g.crowns.length;
  if (!small && rand() < 0.14) { put(x, y0, z, r * 0.62, rnd(2.2, 2.9), shade(c, 0.85)); treeKind(g.crowns, n0, x, z, r, small); return; } // a cypress
  put(x, y0, z, r, rnd(0.85, 1.1), c);
  const lobes = small ? (rand() < 0.4 ? 1 : 0) : 1 + (rand() < 0.5 ? 1 : 0);
  for (let k = 0; k < lobes; k++) {
    const a = rnd(0, TAU), d = r * rnd(0.5, 0.75);
    put(x + Math.cos(a) * d, y0 + r * rnd(0.05, 0.4), z + Math.sin(a) * d, r * rnd(0.55, 0.7), rnd(0.85, 1.05), jit(c, 0.06));
  }
  treeKind(g.crowns, n0, x, z, r, small);
}
// The kind of tree is read from a hash of the spot, so the scene's random
// stream stays as it was: mostly broadleaf clumps, some dark conifers and a
// few poplars. Cypresses are the tall ones already drawn.
const CONIFERS = ['#56685a', '#4d6152', '#5f7160', '#546a5e'].map(col), POPLAR = col('#9aa36a'), SUNLIT = col('#a2a767');
function treeKind(cr, n0, x, z, r, small) {
  const main = cr[n0], h = hash2(Math.round(x * 3301) + 71, Math.round(z * 3307) + 5), h2 = hash2(Math.round(z * 2203) + 3, Math.round(x * 2207) + 9);
  if (main.sy > 2) { main.v = V_CYPRESS; main.r *= 0.82; main.c = mixc(main.c, CONIFERS[Math.floor(h2 * 4)], 0.6); return; }
  if (h < (small ? 0.12 : main.W === ID ? 0.24 : 0.12)) {
    cr.length = n0 + 1;
    Object.assign(main, { v: V_CONIFER, r: r * (0.74 + 0.16 * h2), sy: 1.15 + 0.5 * hash2(n0, 7), c: shade(CONIFERS[Math.floor(h2 * 4)], 0.94 + 0.12 * h) });
    return;
  }
  if (!small && h > 0.965) {
    cr.length = n0 + 1;
    Object.assign(main, { r: r * 0.56, sy: 1.9 + 0.4 * h2, c: mixc(main.c, POPLAR, 0.5) });
    return;
  }
  if (h2 < 0.2) for (let k = n0; k < cr.length; k++) cr[k].c = mixc(cr[k].c, SUNLIT, 0.35); // a few lighter, yellower crowns
}

// Arch panel: a wall S long, H tall, `depth` thick, with one round arch.
function archPanel(S, H, halfW, spring, depth, segs = 8) {
  const c = S / 2, sh = new THREE.Shape();
  sh.moveTo(0, 0); sh.lineTo(c - halfW, 0); sh.lineTo(c - halfW, spring);
  sh.absarc(c, spring, halfW, Math.PI, 0, true);
  sh.lineTo(c + halfW, 0); sh.lineTo(S, 0); sh.lineTo(S, H); sh.lineTo(0, H); sh.lineTo(0, 0);
  let geo = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: segs });
  if (geo.index) geo = geo.toNonIndexed();
  const edges = new THREE.EdgesGeometry(geo, 25).attributes.position.array;
  return { pos: geo.attributes.position.array, edges };
}
// With `inner`, the faces inside an arch (soffit, the insides of the piers) take that colour.
function addTemplate(g, W, tpl, f, colr, st, uvf, inner = null) {
  const p = tpl.pos;
  for (let i = 0; i < p.length; i += 9) {
    const A = [p[i], p[i + 1], p[i + 2]], B = [p[i + 3], p[i + 4], p[i + 5]], C = [p[i + 6], p[i + 7], p[i + 8]];
    const n = inner ? norm(cross(sub(B, A), sub(C, A))) : null;
    g.tri(W, f(...A), f(...B), f(...C), inner && Math.abs(n[2]) < 0.5 && n[1] < 0.5 ? inner : colr, st, uvf(A), uvf(B), uvf(C));
  }
  const e = tpl.edges;
  for (let i = 0; i < e.length; i += 6) g.seg(W, f(e[i], e[i + 1], e[i + 2]), f(e[i + 3], e[i + 4], e[i + 5]));
}

// A box swept along a strip (local x = arc length, y = height, z = across).
function sweepBox(g, W, s0, s1, a0, a1, h0, h1, faces, ds = 0.08, edges = true) {
  const n = Math.max(1, Math.ceil((s1 - s0) / ds));
  for (let i = 0; i < n; i++) {
    const x0 = s0 + (s1 - s0) * i / n, x1 = s0 + (s1 - s0) * (i + 1) / n;
    const ref = [(x0 + x1) / 2, (h0 + h1) / 2, (a0 + a1) / 2];
    if (faces.top) g.quad(W, [x0, h1, a0], [x1, h1, a0], [x1, h1, a1], [x0, h1, a1], faces.top[0], faces.top[1], [x0, a0], [x1, a0], [x1, a1], [x0, a1], ref);
    if (faces.bottom) g.quad(W, [x0, h0, a0], [x1, h0, a0], [x1, h0, a1], [x0, h0, a1], faces.bottom[0], faces.bottom[1], [x0, a0], [x1, a0], [x1, a1], [x0, a1], ref);
    if (faces.left) g.quad(W, [x0, h0, a0], [x1, h0, a0], [x1, h1, a0], [x0, h1, a0], faces.left[0], faces.left[1], [x0, h0], [x1, h0], [x1, h1], [x0, h1], ref);
    if (faces.right) g.quad(W, [x0, h0, a1], [x1, h0, a1], [x1, h1, a1], [x0, h1, a1], faces.right[0], faces.right[1], [x0, h0], [x1, h0], [x1, h1], [x0, h1], ref);
    if (edges) {
      for (const [h, a] of edges === 'top' ? [[h1, a0], [h1, a1]] : [[h0, a0], [h0, a1], [h1, a0], [h1, a1]]) g.seg(W, [x0, h, a], [x1, h, a]);
    }
  }
  if (faces.cap) {
    for (const x of [s0, s1]) {
      g.quad(W, [x, h0, a0], [x, h0, a1], [x, h1, a1], [x, h1, a0], faces.cap[0], faces.cap[1], [a0, h0], [a1, h0], [a1, h1], [a0, h1], [x === s0 ? s0 + 1 : s1 - 1, (h0 + h1) / 2, (a0 + a1) / 2]);
    }
  }
}

// ------------------------------------------------------------ curves & strips

function spline2(ctrl, per = 16, closed = false) {
  const m = ctrl.length, out = [];
  const P = (i) => closed ? ctrl[((i % m) + m) % m] : ctrl[clamp(i, 0, m - 1)];
  const segs = closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  if (!closed) out.push(ctrl[m - 1].slice());
  return out;
}
function resample(pts, step, closed = false) {
  const src = closed ? [...pts, pts[0]] : pts, out = [src[0]];
  let carry = 0;
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1], b = src[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let t = step - carry;
    while (t <= d) { out.push([a[0] + (b[0] - a[0]) * t / d, a[1] + (b[1] - a[1]) * t / d]); t += step; }
    carry = d - (t - step);
  }
  if (closed) out.pop();
  return out;
}
// Distance to a polyline, plus the normalised arc position of the nearest point.
function polyline(pts) {
  const n = pts.length - 1, ax = new Float64Array(n), az = new Float64Array(n), dx = new Float64Array(n);
  const dz = new Float64Array(n), inv = new Float64Array(n), len = new Float64Array(n), cum = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    ax[i] = pts[i][0]; az[i] = pts[i][1]; dx[i] = pts[i + 1][0] - ax[i]; dz[i] = pts[i + 1][1] - az[i];
    const l2 = dx[i] * dx[i] + dz[i] * dz[i] || 1;
    inv[i] = 1 / l2; len[i] = Math.sqrt(l2); cum[i] = total; total += len[i];
  }
  const out = { d: 0, t: 0 };
  return (x, z) => {
    let best = 1e18, bi = 0, bt = 0;
    for (let i = 0; i < n; i++) {
      const px = x - ax[i], pz = z - az[i];
      let t = (px * dx[i] + pz * dz[i]) * inv[i];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = px - t * dx[i], ez = pz - t * dz[i], d2 = ex * ex + ez * ez;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    out.d = Math.sqrt(best); out.t = (cum[bi] + bt * len[bi]) / total;
    return out;
  };
}

// Arc-length parameterised frames. upFn gives the direction the street faces.
// For closed curves sampled at t = i/n, u(s) returns that sample parameter.
function makeFrames(pts, closed, upFn) {
  const n = pts.length, S = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) S[i] = S[i - 1] + len3(sub(pts[i], pts[i - 1]));
  S[n] = S[n - 1] + (closed ? len3(sub(pts[0], pts[n - 1])) : 0);
  const L = closed ? S[n] : S[n - 1];
  const T = [], N = [];
  for (let i = 0; i < n; i++) {
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const t = norm(sub(b, a)), up = upFn(i, pts[i], t);
    T.push(t); N.push(norm(sub(up, scl(t, dot(up, t)))));
  }
  function locate(s) {
    s = closed ? ((s % L) + L) % L : clamp(s, 0, L);
    let lo = 0, hi = closed ? n : n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (S[mid] <= s) lo = mid; else hi = mid; }
    return [lo, (s - S[lo]) / ((S[lo + 1] - S[lo]) || 1)];
  }
  function at(s) {
    const [lo, t] = locate(s), i1 = closed ? (lo + 1) % n : Math.min(lo + 1, n - 1);
    const P = lerp3(pts[lo], pts[i1], t), Tt = norm(lerp3(T[lo], T[i1], t));
    let Nn = lerp3(N[lo], N[i1], t); Nn = norm(sub(Nn, scl(Tt, dot(Nn, Tt))));
    return { P, T: Tt, N: Nn, B: cross(Tt, Nn) };
  }
  const u = (s) => { const [lo, t] = locate(s); return (lo + t) / n; };
  return { at, u, L };
}
function stripWarp(F) {
  let lastX = NaN, lastF = null; // p() and n() are called in pairs at the same x
  const at = (x) => (x === lastX ? lastF : (lastX = x, lastF = F.at(x)));
  return {
    p(x, y, z) { const f = at(x); return [f.P[0] + f.N[0] * y + f.B[0] * z, f.P[1] + f.N[1] * y + f.B[1] * z, f.P[2] + f.N[2] * y + f.B[2] * z]; },
    n(x, y, z, a, b, c) { const f = at(x); return norm([f.T[0] * a + f.N[0] * b + f.B[0] * c, f.T[1] * a + f.N[1] * b + f.B[1] * c, f.T[2] * a + f.N[2] * b + f.B[2] * c]); },
  };
}
// Content authored with y measured outward from a deck at height h. With flip
// the deck faces the other way (a half-turn about the street axis).
function faceWarp(W, h, flip) {
  return flip
    ? { h, flip, p: (x, y, z) => W.p(x, -(h + y), -z), n: (x, y, z, a, b, c) => W.n(x, -(h + y), -z, a, -b, -c) }
    : { h, flip, p: (x, y, z) => W.p(x, h + y, z), n: (x, y, z, a, b, c) => W.n(x, h + y, z, a, b, c) };
}

// ------------------------------------------------------------ sampled 2D fields

function gridField(fn, b, step) {
  const nx = Math.ceil((b.x1 - b.x0) / step) + 1, nz = Math.ceil((b.z1 - b.z0) / step) + 1;
  const v = new Float32Array(nx * nz);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = fn(b.x0 + i * step, b.z0 + j * step);
  return lookup(v, nx, nz, b, step);
}
function distField(samples, b, step, maxR) {
  const nx = Math.ceil((b.x1 - b.x0) / step) + 1, nz = Math.ceil((b.z1 - b.z0) / step) + 1;
  const v = new Float32Array(nx * nz).fill(maxR), k = Math.ceil(maxR / step);
  for (const [x, z] of samples) {
    const ci = Math.round((x - b.x0) / step), cj = Math.round((z - b.z0) / step);
    for (let j = Math.max(0, cj - k); j <= Math.min(nz - 1, cj + k); j++) {
      for (let i = Math.max(0, ci - k); i <= Math.min(nx - 1, ci + k); i++) {
        const d = Math.hypot(b.x0 + i * step - x, b.z0 + j * step - z);
        if (d < v[j * nx + i]) v[j * nx + i] = d;
      }
    }
  }
  return lookup(v, nx, nz, b, step);
}
function lookup(v, nx, nz, b, step) {
  const f = (x, z) => {
    const fx = clamp((x - b.x0) / step, 0, nx - 1.001), fz = clamp((z - b.z0) / step, 0, nz - 1.001);
    const i = fx | 0, j = fz | 0, u = fx - i, w = fz - j;
    const a = v[j * nx + i], c = v[j * nx + i + 1], d = v[(j + 1) * nx + i], e = v[(j + 1) * nx + i + 1];
    return (a * (1 - u) + c * u) * (1 - w) + (d * (1 - u) + e * u) * w;
  };
  f.grad = (x, z) => [(f(x + step, z) - f(x - step, z)) / (2 * step), (f(x, z + step) - f(x, z - step)) / (2 * step)];
  f.grid = { v, nx, nz, b, step };
  return f;
}
class Hash {
  constructor(cell) { this.cell = cell; this.m = new Map(); }
  key(i, j) { return i * 73856093 ^ j * 19349663; }
  add(o) { const k = this.key(Math.floor(o.x / this.cell), Math.floor(o.z / this.cell)); (this.m.get(k) || this.m.set(k, []).get(k)).push(o); }
  free(x, z, r, reach = 1.4) {
    const c = this.cell, i0 = Math.floor((x - reach) / c), i1 = Math.floor((x + reach) / c);
    const j0 = Math.floor((z - reach) / c), j1 = Math.floor((z + reach) / c);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = this.m.get(this.key(i, j));
      if (list) for (const o of list) if (Math.hypot(o.x - x, o.z - z) < (o.r + r) * 0.5) return false;
    }
    return true;
  }
}

// ------------------------------------------------------------ buildings

// Run fn on the buildings' own random stream, so dressing a facade never moves
// a lot or a tree.
function detail(fn) { const keep = rand; rand = bStream; fn(); rand = keep; }
// Most walls are cream or bone; now and then an ochre, yellow, pink or terracotta one.
const facade = (warm) => jit(rand() < warm ? pick(PAL.warmWalls) : pick(PAL.walls), 0.035);

// A cornice: a band t high that oversails the wall head by o, capped with lid.
function cornice(g, W, f, sx, sz, y, t, o, trim, lid, lidSt = 8) {
  box(g, W, (x, yy, z) => f(x, yy + y, z), sx + 2 * o, t, sz + 2 * o, { wall: trim, wallSt: 0, top: lid, topSt: lidSt });
}

// A mansard: a steep lower slope all round, then a low hipped cap.
function mansardRoof(g, W, f, sx, sz, hm, colr) {
  const o = 0.01, ex = sx / 2 + o, ez = sz / 2 + o, ins = Math.min(sx, sz) * 0.2, ix = sx / 2 - ins, iz = sz / 2 - ins;
  const lo = [f(-ex, 0, -ez), f(ex, 0, -ez), f(ex, 0, ez), f(-ex, 0, ez)], hi = [f(-ix, hm, -iz), f(ix, hm, -iz), f(ix, hm, iz), f(-ix, hm, iz)];
  const ref = f(0, -0.2, 0), uv = (p) => [0, p[1] * 3];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    g.quad(W, lo[i], lo[j], hi[j], hi[i], shade(colr, i % 2 ? 0.96 : 1), 5, uv(lo[i]), uv(lo[j]), uv(hi[j]), uv(hi[i]), ref);
    g.seg(W, lo[i], lo[j]); g.seg(W, lo[i], hi[i]);
  }
  hipRoof(g, W, (x, y, z) => f(x, y + hm, z), 2 * ix, 2 * iz, Math.min(ix, iz) * 0.5, shade(colr, 1.03));
}

// A spire over a square tower top w wide: an octagonal needle and four corner pinnacles.
function spire(g, W, f, w, h, colr) {
  cone(g, W, f, w * 0.6, h, 8, colr);
  for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) cone(g, W, (x, y, z) => f(x + a * w * 0.4, y, z + c * w * 0.4), w * 0.12, h * 0.22, 4, colr);
}

function house(g, W, f, sx, sz, h, roofChance = 0.85, split = true) { detail(() => dressHouse(g, W, f, sx, sz, h, roofChance, split)); }

function dressHouse(g, W, f, sx, sz, h, roofChance, split) {
  const long = Math.max(sx, sz), alongX = sx >= sz;
  if (split && long > 0.1 && rand() < 0.4) { // two narrow townhouses of different heights, one roof type for the pair
    const a = long * rnd(0.4, 0.6), b = long - a, rc = rand() < roofChance ? 1 : 0;
    const at = (d) => (alongX ? (x, y, z) => f(x + d, y, z) : (x, y, z) => f(x, y, z + d));
    house(g, W, at((a - long) / 2), alongX ? a : sx, alongX ? sz : a, h * rnd(0.95, 1.25), rc, false);
    house(g, W, at((long - b) / 2), alongX ? b : sx, alongX ? sz : b, h * rnd(0.8, 1.1), rc, false);
    return;
  }
  const wall = facade(0.12);
  const roofed = rand() < roofChance, flatTop = jit(pick(PAL.flat), 0.05);
  const kind = !roofed ? 'flat' : h > 0.16 && rand() < 0.4 ? 'mansard' : rand() < 0.35 ? 'gable' : 'hip';
  const corniced = kind === 'mansard' || (kind === 'flat' && h <= 0.17 && rand() < 0.7);
  box(g, W, f, sx, h, sz, { wall, wallSt: 1, top: corniced ? null : roofed ? wall : flatTop, topSt: roofed ? 0 : 8 });
  if (corniced) cornice(g, W, f, sx, sz, h, 0.01, 0.006, shade(wall, 1.05), roofed ? wall : flatTop, roofed ? 0 : 8);
  if (!roofed && h > 0.17) { // a parapet rim on the taller blocks
    const t = Math.min(sx, sz) * 0.07, rim = shade(wall, 0.96), fr = (x, y, z) => f(x, y + h, z);
    for (const [cx, cz, lx, lz] of [[0, -sz / 2 + t / 2, sx, t], [0, sz / 2 - t / 2, sx, t], [-sx / 2 + t / 2, 0, t, sz - 2 * t], [sx / 2 - t / 2, 0, t, sz - 2 * t]]) {
      box(g, W, (x, y, z) => fr(x + cx, y, z + cz), lx, 0.012, lz, { wall: rim, wallSt: 0, top: rim, edges: false });
    }
  }
  if (kind === 'mansard') {
    mansardRoof(g, W, (x, y, z) => f(x, y + h + 0.01, z), sx, sz, Math.min(sx, sz) * rnd(0.3, 0.4), jit(pick(PAL.roofs), 0.05));
  } else if (roofed) {
    const hr = Math.min(sx, sz) * rnd(0.3, 0.45);
    const fr = (x, y, z) => f(x, y + h, z);
    hipRoof(g, W, fr, sx, sz, hr, jit(pick(PAL.roofs), 0.05), kind === 'gable', wall);
    if (rand() < 0.35) { // a chimney stack
      const cs = Math.min(sx, sz) * 0.14;
      box(g, W, (x, y, z) => f(x + sx * 0.22, y + h, z + sz * 0.2), cs, hr * 1.25, cs, { wall: jit(col('#c9b8a4')), wallSt: 0, top: col('#8f8175') });
    }
  } else if (rand() < 0.18) {
    const s = Math.min(sx, sz) * rnd(0.22, 0.34);
    box(g, W, (x, y, z) => f(x + sx * 0.15, y + h, z), s, s * 0.6, s, { wall: jit(pick(PAL.flat)), wallSt: 0, top: jit(pick(PAL.flat)) });
  }
  // balconies on the taller blocks, one slab per floor on the front
  if (h > 0.19 && rand() < 0.55) {
    const bw = sx * rnd(0.55, 0.8), bc = shade(wall, 1.04);
    for (let y = 0.068; y < h - 0.03; y += 0.056) {
      box(g, W, (x, yy, z) => f(x, yy + y, z + sz / 2 + 0.009), bw, 0.008, 0.018, { wall: bc, wallSt: 0, top: bc, baseEdges: false });
    }
  }
  // a lower wing on some of them, so the blocks are not all single boxes
  if (rand() < 0.3 && h > 0.1) {
    const wx = sx * rnd(0.45, 0.7), wz = sz * rnd(0.35, 0.55), wh = h * rnd(0.5, 0.75);
    const fw = (x, y, z) => f(x - sx * 0.5 + wx * 0.45, y, z + sz * 0.5 + wz * 0.4);
    box(g, W, fw, wx, wh, wz, { wall: jit(wall, 0.03), wallSt: 1, top: jit(pick(PAL.flat), 0.04) });
    if (roofed) hipRoof(g, W, (x, y, z) => fw(x, y + wh, z), wx, wz, Math.min(wx, wz) * 0.4, jit(pick(PAL.roofs), 0.05));
  }
}

// Mid-rise blocks downtown: a cornice, and now and then a set-back attic storey
// or a plant room on the roof.
function block(g, W, f, sx, sz, h) {
  detail(() => {
    const wall = facade(0.05), lid = jit(pick(PAL.flat), 0.04), trim = shade(wall, 1.05);
    const attic = h > 0.3 && rand() < 0.45 ? rnd(0.05, 0.08) : 0, hb = h - attic;
    box(g, W, f, sx, hb, sz, { wall, wallSt: 1, top: null });
    cornice(g, W, f, sx, sz, hb, 0.012, 0.007, trim, lid);
    if (attic) {
      const k = rnd(0.68, 0.82);
      box(g, W, (x, y, z) => f(x, y + hb + 0.012, z), sx * k, attic, sz * k, { wall, wallSt: 1, top: lid, topSt: 8, v0: hb });
    } else if (rand() < 0.45) {
      const m = Math.min(sx, sz) * rnd(0.25, 0.4);
      box(g, W, (x, y, z) => f(x + sx * rnd(-0.2, 0.2), y + hb + 0.012, z + sz * rnd(-0.2, 0.2)), m, m * 0.45, m, { wall: jit(pick(PAL.flat)), wallSt: 0, top: lid });
    }
  });
}

// Downtown towers: slim shafts of stone or glass, set back in stages with a
// ledge at each, and a crown: stepped, a lantern under a pyramid, a plant room,
// or for the landmark, steps, an octagon and a needle.
function tower(g, W, f, s, h, glass, landmark = false) {
  detail(() => {
    const base = glass ? pick(PAL.glass) : pick(PAL.stoneTower), trim = jit(pick(PAL.stoneTower), 0.03), lid = jit(pick(PAL.flat), 0.04);
    const crown = landmark ? 'needle' : glass ? pick(['flat', 'flat', 'steps']) : pick(['steps', 'steps', 'lantern', 'flat']);
    const crownH = crown === 'flat' ? 0 : h * (landmark ? 0.12 : rnd(0.07, 0.11));
    const shaft = h - crownH, tiers = shaft > 1.4 ? 3 : shaft > 0.8 ? 2 : 1, wallSt = glass ? 2 : 1;
    let y = 0, sx = glass ? s * 1.15 : s, sz = s * rnd(0.74, 1); // glass towers are broader slabs
    const at = (dy) => (x, yy, z) => f(x, yy + dy, z);
    const stage = (th, st = wallSt) => { box(g, W, at(y), sx, th, sz, { wall: jit(base, 0.03), wallSt: st, top: null, v0: y }); y += th; };
    const ledge = (t, o) => { box(g, W, at(y), sx + 2 * o, t, sz + 2 * o, { wall: trim, wallSt: 0, top: lid, topSt: 8 }); y += t; };
    for (let t = 0; t < tiers; t++) {
      stage(t === tiers - 1 ? shaft - y : (shaft - y) * rnd(0.6, 0.74));
      ledge(0.016, 0.007);
      if (t < tiers - 1) { sx *= rnd(0.8, 0.88); sz *= rnd(0.8, 0.88); }
    }
    if (crown === 'steps' || crown === 'needle') {
      const w = crown === 'needle' ? [0.34, 0.26, 0.2] : rand() < 0.5 ? [0.55, 0.45] : [0.42, 0.33, 0.25];
      for (const k of w) { sx *= 0.8; sz *= 0.8; stage(crownH * k); ledge(0.01, 0.005); }
      if (crown === 'needle') {
        cylinder(g, W, at(y), sx * 0.34, 0.07, 8, trim, lid, 1);
        cone(g, W, at(y + 0.07), sx * 0.3, 0.2, 8, col('#bcbfbb'));
      } else if (rand() < 0.6) {
        const m = Math.min(sx, sz) * 0.45;
        box(g, W, at(y), m, m * 0.6, m, { wall: trim, wallSt: 0, top: lid });
      }
    } else if (crown === 'lantern') { // an open pavilion under a pyramid
      sx *= 0.66; sz = sx;
      stage(crownH * 0.5, 1); ledge(0.01, 0.006);
      hipRoof(g, W, at(y), sx, sz, crownH * 0.5, jit(rand() < 0.5 ? col(PAL.copper) : col(PAL.slate), 0.04));
    } else if (rand() < 0.6) { // a plant room
      const m = Math.min(sx, sz) * rnd(0.35, 0.5);
      box(g, W, (x, yy, z) => f(x + sx * 0.12, yy + y, z), m, m * 0.5, m, { wall: jit(pick(PAL.flat)), wallSt: 0, top: lid });
    }
    if (!landmark && rand() < 0.65) { // a lower block beside the shaft
      const aw = rnd(0.06, 0.085), side = rand() < 0.5 ? -1 : 1;
      block(g, W, (x, yy, z) => f(x + side * (s / 2 + aw / 2), yy, z), aw, s * rnd(0.8, 1.05), Math.min(h * 0.4, rnd(0.18, 0.34)));
    }
  });
}

// ------------------------------------------------------------ the city

function buildCity() {
  reseed(11);
  const g = new Geo(), wg = new Geo();
  const rx = 4.85, rz = 4.75;
  const bump = (th, c, w) => { const d = Math.atan2(Math.sin(th - c), Math.cos(th - c)); return Math.exp(-(d * d) / (w * w)); };
  const coast = (th) => 1 + 0.05 * Math.cos(2 * th - 0.6) + 0.045 * Math.cos(3 * th + 1.2) + 0.035 * Math.cos(5 * th + 2.1)
    + 0.16 * (fbm(Math.cos(th) * 2.6 + 11, Math.sin(th) * 2.6 + 3, 4) - 0.5) + 0.06 * (vnoise(Math.cos(th) * 9 + 40, Math.sin(th) * 9 + 9) - 0.5)
    + 0.025 * (vnoise(Math.cos(th) * 23 + 2, Math.sin(th) * 23 + 5) - 0.5)
    + 0.1 * bump(th, 2.38, 0.1) - 0.07 * bump(th, 1.95, 0.16) - 0.06 * bump(th, 0.55, 0.14) + 0.05 * bump(th, 0.2, 0.1);
  const landRaw = (x, z) => { const u = x / rx, v = z / rz; return (coast(Math.atan2(v, u)) - Math.hypot(u, v)) * 4.6; };

  const riverA = spline2([[0.9, -5.6], [0.6, -3.7], [-0.15, -2.45], [-0.35, -1.15], [0.15, 0.05], [0.25, 1.25], [-0.45, 2.3], [-1.3, 3.25], [-1.9, 4.9]], 24);
  const riverB = spline2([[-0.35, -1.15], [-1.4, -0.5], [-1.75, 0.6], [-1.25, 1.65], [-0.6, 2.2]], 24);
  const distA = polyline(riverA), distB = polyline(riverB);
  const LK = { x: -1.05, z: 3.0, rx: 1.0, rz: 0.62 }; // the harbour basin
  const waterRaw = (x, z) => {
    const a = distA(x, z), wa = a.d - (0.28 + 0.05 * Math.sin(a.t * 17) + 0.4 * smooth(0.62, 1.0, a.t)), wb = distB(x, z).d - 0.15;
    const th = Math.atan2((z - LK.z) / LK.rz, (x - LK.x) / LK.rx);
    const lr = 1 + 0.16 * (vnoise(Math.cos(th) * 2.2 + 5, Math.sin(th) * 2.2 + 2) - 0.5);
    const dl = (Math.hypot((x - LK.x) / LK.rx, (z - LK.z) / LK.rz) - lr) * 1.2;
    return Math.min(wa, wb, dl, Math.hypot(x - 2.5, z - 2.55) - 0.42);
  };
  const BB = { x0: -rx - 0.8, x1: rx + 0.8, z0: -rz - 0.8, z1: rz + 0.8 };
  const landS = gridField(landRaw, BB, 0.04);
  const waterS = gridField(waterRaw, BB, 0.04);
  const HC = [-2.55, -2.2], HH = 0.3;
  const hillR = (x, z) => { const th = Math.atan2(z - HC[1], x - HC[0]); return 0.88 + 0.1 * (vnoise(Math.cos(th) * 2 + 7, Math.sin(th) * 2 + 1) - 0.5); };
  const hillD = (x, z) => Math.hypot(x - HC[0], z - HC[1]) - hillR(x, z); // < 0 on the plateau
  const hillH = (x, z) => HH * smooth(0.06, -0.06, hillD(x, z));
  const groundH = (x, z) => { const w = waterS(x, z); return (w < 0.1 ? -0.15 * smooth(0.1, -0.08, w) : 0) + hillH(x, z); };
  const pond = { x: 2.5, z: 2.55, r: 0.42 }; // a round pond in the park by the domed hall

  // ---- ground, water, cliffs (radial mesh so the coast is a smooth curve)
  const K = 84, J = 420;
  // Where the river meets the coast the water runs on past the rocks and
  // fades into the paper. Each water vertex carries (fade to paper, distance
  // from the bank) and a tint: darker up the river, lighter toward the mouths.
  const mouth = [];
  for (let j = 0; j < J; j++) {
    const th = j / J * TAU, c0 = coast(th), x = rx * c0 * Math.cos(th), z = rz * c0 * Math.sin(th);
    if (waterS(x, z) < -0.01) mouth.push([x, z]);
  }
  const mouthD = distField(mouth, { x0: -rx - 1.6, x1: rx + 1.6, z0: -rz - 1.6, z1: rz + 1.6 }, 0.05, 1.6);
  const WD = col(PAL.water), WL = col('#b2c7ca');
  const seaFade = (x, z) => {
    const out = -landRaw(x, z), reach = 0.5 * (0.6 + 0.8 * fbm(x * 1.4 + 17, z * 1.4 + 5, 3));
    return out < -0.01 ? 0 : Math.max(smooth(0.03, reach, out), smooth(0.25, 0.8, mouthD(x, z)));
  };
  const waterVert = (v) => {
    const [x, , z] = v, open = Math.max(smooth(0.02, -0.2, waterS(x, z)), smooth(0, 0.12, -landRaw(x, z)));
    return { p: [x, -0.035, z], u: [seaFade(x, z), open], c: mixc(WD, WL, 0.85 * smooth(2.2, 0.2, mouthD(x, z))) };
  };
  const UP = [0, 1, 0];
  const waterTri = (a, b, c) => wg.triN(ID, a.p, b.p, c.p, UP, UP, UP, a.c, b.c, c.c, 0, a.u, b.u, c.u);
  const ringP = [];
  for (let k = 0; k <= K; k++) {
    const row = [];
    for (let j = 0; j < J; j++) {
      const th = j / J * TAU, rho = Math.pow(k / K, 0.75) * coast(th);
      const x = rx * rho * Math.cos(th), z = rz * rho * Math.sin(th);
      row.push([x, groundH(x, z), z]);
    }
    ringP.push(row);
  }
  const GR = col(PAL.ground), PK = col(PAL.park), BK = col(PAL.bank), BED = col('#8d9c8a');
  const parkMask = (x, z) => Math.max(smooth(0.56, 0.64, fbm(x * 0.42 + 3, z * 0.42 + 7)), smooth(1.25, 0.8, Math.hypot(x - 2.5, z - 2.55)));
  const groundCol = (p) => {
    const [x, , z] = p, w = waterS(x, z);
    if (w < -0.02) return BED;
    let c = mixc(GR, PK, parkMask(x, z) * 0.9);
    c = mixc(c, BK, smooth(0.3, 0.06, w) * 0.85);
    c = mixc(c, PK, smooth(0.35, 0.05, landS(x, z)) * 0.7); // green verge along the shore
    return mixc(c, shade(GR, 1.02), 0.3 * (1 - smooth(0, 1.6, Math.hypot(x - 1.5, z + 1.5))));
  };
  for (let k = 1; k <= K; k++) {
    for (let j = 0; j < J; j++) {
      const j1 = (j + 1) % J;
      const a = ringP[k - 1][j], b = ringP[k - 1][j1], c = ringP[k][j1], d = ringP[k][j];
      const tris = k === 1 ? [[a, c, d]] : [[a, b, c], [a, c, d]];
      for (const [p, q, r] of tris) {
        const ctr = scl(add(add(p, q), r), 1 / 3), below = [ctr[0], ctr[1] - 1, ctr[2]]; // ground always faces up
        g.tri(ID, p, q, r, groundCol(ctr), 3, [p[0], p[2]], [q[0], q[2]], [r[0], r[2]], below);
        const wmin = Math.min(waterS(p[0], p[2]), waterS(q[0], q[2]), waterS(r[0], r[2]));
        if (wmin < 0.06) waterTri(waterVert(p), waterVert(q), waterVert(r));
      }
    }
  }
  // cliffs
  const RK = col(PAL.rock), depths = [0, -0.05, -0.11, -0.17, -0.23, -0.28], outs = [0, 0.008, 0.014, 0.01, 0.0, -0.025];
  const cliffP = [];
  const shoal = (x, z) => smooth(1.25, 0.7, mouthD(x, z)); // by the mouths the rock stands in the water, not above the paper
  const rocky = (x, z) => 0.55 + 0.7 * smooth(0.36, 0.68, fbm(x * 0.8 + 3, z * 0.8 + 8, 3)); // outcrops, and quieter stretches between
  const sit = (x, z, y) => { // small rocks sit higher, on the rim rather than below it
    const yy = y + 0.3 * Math.max(0, 1 - rocky(x, z));
    return yy + (Math.max(yy, -0.06) - yy) * shoal(x, z);
  };
  const mossy = (x, z) => 0.6 * smooth(0.45, 0.72, vnoise(x * 2.3 + 1, z * 2.3 + 4));
  for (let j = 0; j < J; j++) {
    const th = j / J * TAU, top = ringP[K][j], c0 = coast(th);
    const col0 = [], deep = 1 - 0.78 * shoal(top[0], top[2]);
    for (let m = 0; m < depths.length; m++) {
      const rho = c0 * (1 + outs[m]) + (m ? 0.018 * (vnoise(j * 0.35, m * 3.1) - 0.5) : 0);
      const y = m === 0 ? top[1] : Math.min(top[1], 0) + (depths[m] + 0.03 * (vnoise(j * 0.5 + 9, m) - 0.5)) * deep;
      col0.push([rx * rho * Math.cos(th), y, rz * rho * Math.sin(th)]);
    }
    cliffP.push(col0);
  }
  const openRim = (j) => { const [x, , z] = cliffP[j][0]; return waterS(x, z) < -0.01; };
  for (let j = 0; j < J; j++) {
    const j1 = (j + 1) % J, open = openRim(j) || openRim(j1);
    for (let m = 1; m < depths.length; m++) {
      const cc = jit(shade(RK, 1 - 0.07 * m), 0.08);
      if (!open) g.quad(ID, cliffP[j][m - 1], cliffP[j1][m - 1], cliffP[j1][m], cliffP[j][m], cc, 6, Z2, Z2, Z2, Z2, [0, -0.25, 0]);
    }
    if (j % 3 === 0 && !open && !openRim((j + 3) % J)) g.seg(ID, cliffP[j][0], cliffP[(j + 3) % J][0]);
  }
  // the sea: rings beyond the coast, kept only where the water has not yet faded out
  {
    const RINGS = 10, OUT = 0.16, seaP = [];
    for (let m = 0; m <= RINGS; m++) {
      const row = [];
      for (let j = 0; j < J; j++) {
        const th = j / J * TAU, rho = coast(th) * (1 + OUT * m / RINGS);
        row.push(waterVert([rx * rho * Math.cos(th), 0, rz * rho * Math.sin(th)]));
      }
      seaP.push(row);
    }
    for (let m = 1; m <= RINGS; m++) {
      for (let j = 0; j < J; j++) {
        const j1 = (j + 1) % J, a = seaP[m - 1][j], b = seaP[m - 1][j1], c = seaP[m][j1], d = seaP[m][j];
        if (Math.min(a.u[0], b.u[0], c.u[0], d.u[0]) > 0.999) continue;
        waterTri(a, b, c); waterTri(a, c, d);
      }
    }
  }
  // boulders along the shore
  for (let j = 0; j < J; j++) {
    if (rand() < 0.7) {
      const th = (j + rnd(0, 1)) / J * TAU, rho = coast(th) * (1 + rnd(-0.005, 0.025));
      const r = rnd(0.05, 0.16), x = rx * rho * Math.cos(th), z = rz * rho * Math.sin(th);
      if (waterS(x, z) < 0.02) continue;
      boulder(g, ID, X(x, sit(x, z, -0.3 + rnd(0, 0.14)), z, rnd(0, TAU)), r * rocky(x, z), rnd(0.55, 0.9), jit(RK, 0.1), 0.1, mossy(x, z));
    }
  }
  // pale rocks piled along the rim, as in the painting
  for (let j = 0; j < J; j++) {
    if (rand() < 0.55) {
      const th = (j + rnd(0, 1)) / J * TAU, rho = coast(th) * (1 + rnd(-0.012, 0.012));
      const r = rnd(0.06, 0.15), x = rx * rho * Math.cos(th), z = rz * rho * Math.sin(th);
      if (waterS(x, z) < 0.05) continue;
      boulder(g, ID, X(x, sit(x, z, -0.16 + rnd(0, 0.1)), z, rnd(0, TAU)), r * rocky(x, z), rnd(0.6, 0.95), jit(shade(RK, 1.05), 0.08), 0.1, mossy(x, z));
    }
  }

  // ---- roads & viaduct
  const roadCtrl = [
    [[-5.0, -1.6], [-3.3, -1.75], [-1.6, -1.95], [0.2, -2.0], [1.9, -2.35], [3.6, -2.05], [5.0, -1.5]],
    [[-4.8, 0.9], [-3.2, 0.75], [-1.6, 0.15], [-0.2, -0.3], [1.5, -0.1], [3.2, 0.3], [4.9, 0.4]],
    [[2.5, -3.9], [2.6, -2.4], [2.4, -0.9], [2.5, 0.8], [2.2, 1.7], [1.9, 2.5], [2.0, 3.2], [2.05, 3.7]],
    [[-2.9, -3.5], [-3.1, -1.8], [-3.3, -0.2], [-3.0, 1.6], [-2.4, 3.0]],
    [[-1.0, -3.7], [-0.8, -2.75], [0.35, -2.5], [0.9, -1.2], [1.3, 0.6], [1.9, 1.5]],
    [[3.1, -3.5], [3.7, -2.6], [4.2, -1.3], [4.0, 0.4], [3.5, 1.9], [2.6, 3.2]],
    [[-4.3, 2.1], [-3.3, 2.5], [-2.3, 2.1], [-1.6, 1.3]],
    [[0.9, 2.1], [1.6, 1.9], [2.1, 1.2], [3.0, 0.9], [4.3, 1.4]],
    [[-3.9, -0.4], [-2.8, -0.2], [-1.9, 0.9], [-2.6, 2.1]],
  ];
  const ringCtrl = [];
  for (let i = 0; i < 40; i++) { const th = i / 40 * TAU, rho = coast(th) - 0.075; ringCtrl.push([rx * rho * Math.cos(th), rz * rho * Math.sin(th)]); }
  const roads = [...roadCtrl.map((c) => resample(spline2(c, 12), 0.03)), resample(spline2(ringCtrl, 6, true), 0.03, true)];
  roads[roads.length - 1].closed = true;
  const viaCtrl = [[3.75, -0.95], [3.2, -0.3], [2.3, 0.35], [1.1, 0.55], [0.1, 0.62], [-0.9, 0.25], [-2.1, -0.55], [-3.45, -1.05]];
  const viaPts = resample(spline2(viaCtrl, 16), 0.03);
  // The ring road climbs onto arches round the south-east shore, like the painted
  // elevated road; elevH is its deck height along the road (samples are 0.03 apart).
  const RW = 0.072, EI = roads.length - 1, EH = 0.26, RAMP = 0.8;
  const eRoad = roads[EI], thAt = ([x, z]) => Math.atan2(z / rz, x / rx);
  const eA = eRoad.findIndex((p) => thAt(p) > 0.13) * 0.03, eB = eRoad.findIndex((p) => thAt(p) > 1.45) * 0.03;
  const elevH = (s) => EH * smooth(eA, eA + RAMP, s) * smooth(eB, eB - RAMP, s);
  const roadC = distField(roads.flat(), BB, 0.04, 0.7);
  // distance from a road, less its width beyond 0.062 (the margins below count from there)
  const roadD = (x, z) => roadC(x, z) - (RW - 0.062);
  roadD.grad = roadC.grad;
  const viaD = distField([...viaPts, ...eRoad.filter((_, k) => elevH(k * 0.03) > 0.06)], BB, 0.04, 0.7);
  // distance to the nearest other road, so kerbs open up where roads meet (not under the elevated deck)
  const RH = new Map(), rkey = (x, z) => Math.floor(x / 0.25) * 4099 + Math.floor(z / 0.25);
  roads.forEach((r, i) => r.forEach(([x, z], k) => {
    if (i === EI && elevH(k * 0.03) > 0.1) return;
    const key = rkey(x, z); (RH.get(key) || RH.set(key, []).get(key)).push(x, z, i);
  }));
  const otherRoad = (x, z, i) => {
    let best = 1;
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const l = RH.get(rkey(x + a * 0.25, z + b * 0.25));
      if (l) for (let m = 0; m < l.length; m += 3) if (l[m + 2] !== i) { const dx = l[m] - x, dz = l[m + 1] - z; best = Math.min(best, dx * dx + dz * dz); }
    }
    return Math.sqrt(best);
  };
  const kerbAt = (x, z, i) => smooth(RW * 0.9, RW + 0.05, otherRoad(x, z, i));

  const RD = col(PAL.road);
  // a road surface along a strip, grey with pale kerbs inked at the edge (style 9: aWall = kerb weight, across)
  const roadStrip = (W, s0, s1, hw, y) => {
    const n = Math.max(1, Math.ceil((s1 - s0) / 0.06));
    for (let i = 0; i < n; i++) {
      const x0 = s0 + (s1 - s0) * i / n, x1 = s0 + (s1 - s0) * (i + 1) / n;
      g.quad(W, [x0, y, -hw], [x1, y, -hw], [x1, y, hw], [x0, y, hw], RD, 9, [1, -1], [1, -1], [1, 1], [1, 1], [(x0 + x1) / 2, y - 1, 0]);
    }
  };
  const bridges = [];
  roads.forEach((road, ri) => {
    const n = road.length, onLand = road.map(([x, z]) => waterS(x, z) > 0.05 && landS(x, z) > 0.04);
    for (let i = 1; i + 2 < n; i++) { // a road that only grazes the bank stays on the ground
      const run = onLand[i - 1] && !onLand[i] ? (onLand[i + 1] ? 1 : onLand[i + 2] ? 2 : 0) : 0;
      if (run && landS(road[i][0], road[i][1]) > 0.1) for (let k = 0; k < run; k++) onLand[i + k] = true;
    }
    const segs = road.closed ? n : n - 1;
    const kerbs = road.map(([x, z], i) => {
      const b = road[Math.min(i + 1, n - 1)], a = road[Math.max(i - 1, 0)], t = norm([b[0] - a[0], 0, b[1] - a[1]]);
      return [-1, 1].map((k) => kerbAt(x - t[2] * RW * k, z + t[0] * RW * k, ri));
    });
    for (let i = 0; i < segs; i++) {
      const i1 = (i + 1) % n, a = road[i], b = road[i1];
      if (!onLand[i] || !onLand[i1]) continue;
      if (ri === EI && elevH(i * 0.03) > 0 && elevH((i + 1) * 0.03) > 0) continue; // under the elevated deck
      const t = norm([b[0] - a[0], 0, b[1] - a[1]]), nx = -t[2] * RW, nz = t[0] * RW;
      const ya = hillH(a[0], a[1]) + 0.004, yb = hillH(b[0], b[1]) + 0.004;
      g.quad(ID, [a[0] - nx, ya, a[1] - nz], [a[0] + nx, ya, a[1] + nz], [b[0] + nx, yb, b[1] + nz], [b[0] - nx, yb, b[1] - nz], RD, 9,
        [kerbs[i][0], -1], [kerbs[i][1], 1], [kerbs[i1][1], 1], [kerbs[i1][0], -1], [a[0], ya - 1, a[1]]);
      if (i % 4 === 0 && Math.min(kerbs[i][0], kerbs[i][1], kerbs[i1][0], kerbs[i1][1]) > 0.5) g.seg(ID, [a[0], ya + 0.001, a[1]], [b[0], yb + 0.001, b[1]]); // centre line
    }
    for (let i = 1; i < n; i++) {
      if (onLand[i - 1] && !onLand[i]) {
        let j = i; while (j < n && !onLand[j]) j++;
        if (j < n && landS(road[i][0], road[i][1]) > 0.1) bridges.push(road.slice(Math.max(0, i - 3), Math.min(n, j + 3)));
        i = j;
      }
    }
  });
  const ST = col(PAL.stone);
  const cityRand = rand; reseed(23); // the bridges and the elevated road draw their own stone
  const solidPanel = (S, H, depth) => {
    const geo = new THREE.BoxGeometry(S, H, depth).translate(S / 2, H / 2, depth / 2).toNonIndexed();
    return { pos: geo.attributes.position.array, edges: new THREE.EdgesGeometry(geo, 25).attributes.position.array };
  };
  // A wall from y0 up to the deck's underside.
  const wallUnder = (W, tpl, s0, y0, a0, bottom, c) => addTemplate(g, W, tpl, (x, y, z) => [s0 + x, y0 + y * (bottom(s0 + x) - y0), a0 + z], c, 4, (p) => [s0 + p[0], y0 + p[1] * (bottom(s0) - y0)]);
  // One span of an arcade: the arch head hangs from the deck's underside and the
  // piers stand from y0 up to where it springs.
  const arcadeTpl = (S, hw, Ha, depth) => ({ S, hw, Ha, head: archPanel(S, Ha, hw, 0, depth), pier: solidPanel(S / 2 - hw, 1, depth) });
  const arcade = (W, t, s0, y0, a0, bottom, c) => {
    const inner = shade(c, 0.66), spring = (s) => bottom(s) - t.Ha, pw = t.S / 2 - t.hw;
    addTemplate(g, W, t.head, (x, y, z) => [s0 + x, spring(s0 + x) + y, a0 + z], c, 4, (p) => [s0 + p[0], p[1]], inner);
    for (const x0 of [s0, s0 + t.S - pw]) {
      const ys = spring(x0);
      addTemplate(g, W, t.pier, (x, y, z) => [x0 + x, y0 + y * (spring(x0 + x) - y0), a0 + z], c, 4, (p) => [x0 + p[0], y0 + p[1] * (ys - y0)], inner);
    }
  };
  // Stone bridges: the deck lifts off each bank and humps a little over the river,
  // on round arches whose piers have pointed cutwaters, with a parapet each side.
  for (const bp of bridges) {
    const F = makeFrames(bp.map(([x, z]) => [x, 0, z]), false, () => [0, 1, 0]);
    const W = stripWarp(F), L = F.L, E = Math.min(0.11, L * 0.3), HW = RW + 0.012, PD = 0.07;
    const top = (s) => 0.006 + 0.075 * smooth(0, E, s) * smooth(L, L - E, s) + 0.03 * Math.sin(Math.PI * clamp(s / L, 0, 1));
    const bottom = (s) => top(s) - 0.035;
    const BW = { p: (x, y, z) => W.p(x, y + top(x), z), n: W.n };
    roadStrip(BW, 0, L, RW, 0);
    sweepBox(g, BW, 0, L, -HW, HW, -0.035, 0, { bottom: [shade(ST, 0.85), 4], left: [ST, 4], right: [ST, 4], cap: [ST, 4] }, 0.06);
    for (const a of [-HW, HW - 0.013]) sweepBox(g, BW, 0, L, a, a + 0.013, 0, 0.03, { top: [shade(ST, 1.04), 0], left: [ST, 4], right: [ST, 4], cap: [ST, 4] }, 0.06, 'top');
    const nSp = Math.max(1, Math.round((L - 2 * E) / 0.2)), S = (L - 2 * E) / nSp;
    const t = arcadeTpl(S, S * 0.34, S * 0.34 + 0.014, 2 * PD), wall = solidPanel(E, 1, 2 * PD);
    for (const s0 of [0, L - E]) wallUnder(W, wall, s0, -0.2, -PD, bottom, jit(ST, 0.04));
    for (let i = 0; i < nSp; i++) {
      const s0 = E + i * S;
      arcade(W, t, s0, -0.2, -PD, bottom, jit(ST, 0.04));
      if (i === 0) continue;
      const pw = S / 2 - t.hw, ct = shade(ST, 0.92); // a cutwater each side of the pier
      for (const k of [-1, 1]) {
        const A = [s0 - pw, -0.2, k * PD], B = [s0 + pw, -0.2, k * PD], C = [s0, -0.2, k * (PD + 0.028)];
        const up = (p) => [p[0], -0.022, p[2]];
        g.quad(W, A, C, up(C), up(A), ct, 4, [s0 - pw, -0.2], [s0, -0.2], [s0, -0.022], [s0 - pw, -0.022], [s0, -0.1, k * PD]);
        g.quad(W, C, B, up(B), up(C), ct, 4, [s0, -0.2], [s0 + pw, -0.2], [s0 + pw, -0.022], [s0, -0.022], [s0, -0.1, k * PD]);
        g.tri(W, up(A), up(C), up(B), ct, 0, Z2, Z2, Z2, [s0, -0.1, k * PD]);
        g.seg(W, up(A), up(C)); g.seg(W, up(C), up(B));
      }
    }
  }
  // a few cars, small dark marks in the lanes as in the painting
  const CARS = ['#6f6b66', '#8f5f50', '#5f6a73', '#e9e4d9', '#7d7a70'].map(col);
  roads.forEach((road, ri) => {
    for (let i = 3; i < road.length - 3; i++) {
      if (rand() > 0.045) continue;
      const [x, z] = road[i], b = road[i + 1];
      if (waterS(x, z) < 0.08 || landS(x, z) < 0.06 || (ri === EI && elevH(i * 0.03) > 0) || otherRoad(x, z, ri) < RW + 0.08) continue;
      const k = rand() < 0.5 ? -1 : 1, tx = b[0] - x, tz = b[1] - z, tl = Math.hypot(tx, tz) || 1, off = k * RW * 0.42;
      const c = pick(CARS);
      box(g, ID, X(x - tz / tl * off, hillH(x, z) + 0.004, z + tx / tl * off, Math.atan2(tz, tx)), 0.046, 0.017, 0.024, { wall: c, wallSt: 0, top: shade(c, 1.08), edges: false });
    }
  });
  // the elevated road: arches where it runs high, walls at the feet of the ramps, open spans over the roads it crosses
  {
    const F = makeFrames(eRoad.map(([x, z]) => [x, 0, z]), false, () => [0, 1, 0]), W = stripWarp(F);
    const HW = RW + 0.012, PD = 0.062, deck = (s) => 0.004 + elevH(s), bottom = (s) => deck(s) - 0.045;
    const EW = { p: (x, y, z) => W.p(x, y + deck(x), z), n: W.n };
    roadStrip(EW, eA, eB, RW, 0);
    sweepBox(g, EW, eA, eB, -HW, HW, -0.045, 0, { bottom: [shade(ST, 0.85), 4], left: [ST, 4], right: [ST, 4] }, 0.06);
    for (const a of [-HW, HW - 0.013]) sweepBox(g, EW, eA, eB, a, a + 0.013, 0, 0.03, { top: [shade(ST, 1.04), 0], left: [ST, 4], right: [ST, 4], cap: [ST, 4] }, 0.06, 'top');
    const nSp = Math.round((eB - eA) / 0.26), S = (eB - eA) / nSp;
    const t = arcadeTpl(S, S * 0.33, S * 0.33 + 0.016, 2 * PD), wall = solidPanel(S, 1, 2 * PD), y0 = -0.05;
    for (let i = 0; i < nSp; i++) {
      const s0 = eA + i * S, h = Math.min(bottom(s0), bottom(s0 + S));
      if (Math.max(bottom(s0), bottom(s0 + S)) < 0.01) continue;
      let open = false;
      for (let s = s0; s <= s0 + S; s += 0.03) { const P = F.at(s).P; if (otherRoad(P[0], P[2], EI) < RW + 0.04) open = true; }
      if (open && h > 0.1) continue;
      if (h - t.Ha > y0 + 0.03) arcade(W, t, s0, y0, -PD, bottom, jit(ST, 0.04));
      else wallUnder(W, wall, s0, y0, -PD, bottom, jit(ST, 0.04));
    }
  }
  rand = cityRand;

  // viaduct with arches, and a train shed over each end
  const VF = makeFrames(viaPts.map(([x, z]) => [x, 0, z]), false, () => [0, 1, 0]);
  const VW = stripWarp(VF);
  {
    const nSp = Math.round(VF.L / 0.3), S = VF.L / nSp;
    const tpl = archPanel(S, 0.45, S * 0.33, 0.26, 0.12);
    for (let i = 0; i < nSp; i++) { const c = jit(ST, 0.03); addTemplate(g, VW, tpl, (x, y, z) => [i * S + x, -0.16 + y, -0.06 + z], c, 4, (p) => [i * S + p[0], p[1]], shade(c, 0.72)); }
    sweepBox(g, VW, 0, VF.L, -0.085, 0.085, 0.29, 0.34, { top: [col('#c6c5bf'), 0], bottom: [shade(ST, 0.85), 4], left: [ST, 4], right: [ST, 4], cap: [ST, 4] }, 0.06);
    for (const a of [-0.085, 0.073]) sweepBox(g, VW, 0, VF.L, a, a + 0.012, 0.34, 0.36, { top: [ST, 0], left: [ST, 4], right: [ST, 4] }, 0.06, 'top');
    for (let s = 0; s < VF.L; s += 0.12) for (const a of [-0.026, 0.026]) g.seg(VW, [s, 0.341, a], [Math.min(s + 0.12, VF.L), 0.341, a]); // the rails
  }
  const SHED = 0.95;
  for (const [s0, s1] of [[-0.05, SHED], [VF.L - SHED, VF.L + 0.05]]) {
    const wall = col('#e3d9c6'), roof = col('#a9b1b1');
    for (const a of [-0.2, 0.17]) sweepBox(g, VW, s0, s1, a, a + 0.03, 0, 0.4, { top: [wall, 0], left: [wall, 1], right: [wall, 1], cap: [wall, 1] }, 0.1);
    const segs = 10, rr = 0.2;
    for (let i = 0; i < 14; i++) {
      const x0 = s0 + (s1 - s0) * i / 14, x1 = s0 + (s1 - s0) * (i + 1) / 14;
      for (let k = 0; k < segs; k++) {
        const a0 = Math.PI * k / segs, a1 = Math.PI * (k + 1) / segs;
        const P = (x, a) => [x, 0.4 + rr * 0.7 * Math.sin(a), rr * Math.cos(a) - 0.015];
        g.quad(VW, P(x0, a0), P(x1, a0), P(x1, a1), P(x0, a1), roof, 2, [x0, a0 * rr], [x1, a0 * rr], [x1, a1 * rr], [x0, a1 * rr], [(x0 + x1) / 2, 0.3, 0]);
        g.seg(VW, P(x0, a0), P(x0, a1));
      }
    }
    for (const x of [s0, s1]) for (let k = 0; k < segs; k++) {
      const a0 = Math.PI * k / segs, a1 = Math.PI * (k + 1) / segs;
      const P = (a) => [x, 0.4 + rr * 0.7 * Math.sin(a), rr * Math.cos(a) - 0.015];
      g.tri(VW, [x, 0.4, -0.015], P(a0), P(a1), wall, 0, Z2, Z2, Z2, [x === s0 ? x + 1 : x - 1, 0.5, 0]);
    }
  }

  // each shed: a glazed vent along the ridge, and a glazed lunette with radiating bars in each end
  for (const [s0, s1] of [[-0.05, SHED], [VF.L - SHED, VF.L + 0.05]]) {
    const glass = col('#a3b3b5'), lead = col('#9aa2a2'), rr = 0.2, ctr = [0, 0.4, -0.015];
    sweepBox(g, VW, s0 + 0.08, s1 - 0.08, -0.05, 0.02, 0.52, 0.565, { top: [lead, 0], left: [glass, 2], right: [glass, 2], cap: [glass, 2] }, 0.1, 'top');
    for (const [x, out] of [[s0, -1], [s1, 1]]) {
      const xe = x + out * 0.004, P = (a, k) => [xe, 0.4 + rr * k * 0.7 * Math.sin(a), rr * k * Math.cos(a) - 0.015];
      for (let k = 0; k < 10; k++) {
        const a0 = Math.PI * k / 10, a1 = Math.PI * (k + 1) / 10;
        g.tri(VW, [xe, ctr[1], ctr[2]], P(a0, 0.8), P(a1, 0.8), glass, 0, Z2, Z2, Z2, [x - out, 0.5, 0]);
        g.seg(VW, P(a0, 0.8), P(a1, 0.8));
        if (k % 2 === 1) g.seg(VW, [xe, ctr[1], ctr[2]], P(a1, 0.8));
      }
    }
  }

  // ---- the walled hill: a stone rim with round towers, gates where roads climb it, a cathedral on top
  {
    const rim = [];
    for (let i = 0; i < 120; i++) { const th = i / 120 * TAU; const x0 = HC[0] + Math.cos(th), z0 = HC[1] + Math.sin(th), R = hillR(x0, z0) + 0.06; rim.push([HC[0] + R * Math.cos(th), 0, HC[1] + R * Math.sin(th)]); }
    const RF = makeFrames(rim, true, () => [0, 1, 0]), RW = stripWarp(RF), WALL = col('#cfc6b4');
    let lastTower = -1;
    for (let s0 = 0; s0 < RF.L - 1e-6; s0 += 0.08) {
      const P = RF.at(s0).P;
      if (roadD(P[0], P[2]) < 0.1 || landS(P[0], P[2]) < 0.05) continue;
      sweepBox(g, RW, s0, Math.min(s0 + 0.08, RF.L), -0.018, 0.018, -0.03, HH + 0.04, { top: [WALL, 4], left: [WALL, 4], right: [WALL, 4] }, 0.08, 'top');
      if (s0 - lastTower > 0.55) {
        lastTower = s0;
        cylinder(g, ID, X(P[0], -0.03, P[2]), 0.06, HH + 0.14, 10, jit(WALL, 0.03), null, 4);
        cone(g, ID, X(P[0], HH + 0.11, P[2]), 0.068, 0.1, 10, col(PAL.slate));
      }
    }
  }

  // ---- lots
  const DT = [1.35, -1.75], IND = [3.3, 1.2];
  const zoneAt = (x, z) => {
    if (Math.hypot(x - DT[0], (z - DT[1]) * 1.15) < 1.55) return 'dt';
    if (Math.hypot(x - IND[0], z - IND[1]) < 1.05) return 'ind';
    if (x < -2.3 || hillD(x, z) < 0 || (x < -0.35 && x > -2.1 && z > -1.0 && z < 1.9 && waterS(x, z) > 0)) return 'old';
    return 'res';
  };
  const occ = new Hash(0.5);
  const ok = (x, z, r, need = 0.2) => landS(x, z) > need && waterS(x, z) > 0.1 + r * 0.35 && roadD(x, z) > 0.068 + 0.42 * r && viaD(x, z) > 0.14 + 0.4 * r && Math.abs(hillD(x, z)) > 0.1 + 0.4 * r;
  const place = (target, r, fn) => {
    for (let k = 0; k < 400; k++) {
      const x = target[0] + rnd(-1, 1) * k * 0.004, z = target[1] + rnd(-1, 1) * k * 0.004;
      if (ok(x, z, r * 0.8) && occ.free(x, z, r, 2.2)) { occ.add({ x, z, r }); fn(x, z); return [x, z]; }
    }
    return null;
  };
  const faceAngle = (x, z, fallback) => {
    const cands = [[roadD(x, z), roadD], [viaD(x, z), viaD], [waterS(x, z), waterS]].sort((a, b) => a[0] - b[0]);
    if (cands[0][0] < 0.55) { const [gx, gz] = cands[0][1].grad(x, z); if (Math.hypot(gx, gz) > 0.2) return Math.atan2(gz, gx) + Math.PI / 2; }
    return fallback;
  };

  // landmarks
  place(DT, 0.7, (x, z) => tower(g, ID, X(x, 0, z, 0.1), 0.24, 2.45, false, true));
  place(HC, 0.8, (x, z) => { // cathedral with two west towers, a transept, an apse and a spire over the crossing
    const f = X(x, HH, z, 0.5), wall = col('#e6dcc8'), slate = col(PAL.slate), trim = shade(wall, 1.05);
    box(g, ID, f, 0.56, 0.2, 0.2, { wall, wallSt: 1, top: wall });
    hipRoof(g, ID, (a, b, c) => f(a, b + 0.2, c), 0.56, 0.2, 0.1, slate, true, wall);
    box(g, ID, f, 0.16, 0.18, 0.42, { wall, wallSt: 1, top: wall });
    hipRoof(g, ID, (a, b, c) => f(a, b + 0.18, c), 0.16, 0.42, 0.09, slate, true, wall);
    cylinder(g, ID, (a, b, c) => f(a + 0.28, b, c), 0.1, 0.17, 12, wall, null, 1);
    cone(g, ID, (a, b, c) => f(a + 0.28, b + 0.17, c), 0.105, 0.08, 12, slate);
    for (const a of [-0.21, -0.13, 0.13, 0.2]) for (const side of [-1, 1]) { // buttresses along the nave
      box(g, ID, (u, v, w) => f(u + a, v, w + side * 0.108), 0.022, 0.15, 0.022, { wall: trim, wallSt: 0, top: trim });
    }
    for (const side of [-1, 1]) {
      const ft = (a, b, c) => f(a - 0.3, b, c + side * 0.07);
      box(g, ID, ft, 0.1, 0.5, 0.1, { wall, wallSt: 1, top: wall });
      for (const y of [0.21, 0.5]) cornice(g, ID, ft, 0.1, 0.1, y, 0.012, 0.006, trim, wall, 0);
      spire(g, ID, (a, b, c) => ft(a, b + 0.512, c), 0.1, 0.34, slate);
    }
    const fx = (a, b, c) => f(a, b + 0.255, c); // the crossing
    cylinder(g, ID, fx, 0.034, 0.07, 8, trim, null, 1);
    cone(g, ID, (a, b, c) => fx(a, b + 0.07, c), 0.04, 0.22, 8, slate);
  });
  place([-0.85, 0.75], 0.62, (x, z) => { // church on the river island
    const f = X(x, 0, z, 0.35), wall = col('#ece3d2');
    box(g, ID, f, 0.46, 0.17, 0.2, { wall, wallSt: 1, top: wall });
    hipRoof(g, ID, (a, b, c) => f(a, b + 0.17, c), 0.46, 0.2, 0.1, col(PAL.slate), true, wall);
    const ft = (a, b, c) => f(a - 0.27, b, c), trim = shade(wall, 1.05);
    box(g, ID, ft, 0.12, 0.44, 0.12, { wall, wallSt: 1, top: wall });
    for (const y of [0.3, 0.44]) cornice(g, ID, ft, 0.12, 0.12, y, 0.012, 0.006, trim, wall, 0);
    spire(g, ID, (a, b, c) => ft(a, b + 0.452, c), 0.12, 0.42, col(PAL.slate));
  });
  place([2.45, 1.85], 0.6, (x, z) => { // domed hall by the pond
    const f = X(x, 0, z, -0.2), wall = col('#efe8da'), trim = shade(wall, 1.04), copper = col(PAL.copper);
    box(g, ID, f, 0.42, 0.14, 0.42, { wall, wallSt: 1, top: null });
    cornice(g, ID, f, 0.42, 0.42, 0.14, 0.014, 0.008, trim, wall, 0);
    cylinder(g, ID, (a, b, c) => f(a, b + 0.14, c), 0.14, 0.08, 14, wall, null, 1);
    for (let k = 0; k < 16; k++) { // a ring of columns round the drum, under a thin entablature
      const t = k / 16 * TAU;
      cylinder(g, ID, (a, b, c) => f(a + 0.168 * Math.cos(t), b + 0.154, c + 0.168 * Math.sin(t)), 0.008, 0.066, 5, trim, null, 0, 0.008, false);
    }
    cylinder(g, ID, (a, b, c) => f(a, b + 0.22, c), 0.182, 0.014, 16, trim, trim, 0);
    blob(g, ID, (a, b, c) => f(a, b + 0.2, c), 0.14, 0.75, copper, 0.03, ICO1, 0, 0.1);
    cylinder(g, ID, (a, b, c) => f(a, b + 0.395, c), 0.026, 0.04, 8, trim, null, 1); // lantern
    cone(g, ID, (a, b, c) => f(a, b + 0.435, c), 0.032, 0.045, 8, copper);
  });
  let chimneyTop = null;
  place(IND, 0.8, (x, z) => { // brick works and chimney
    const f = X(x, 0, z, 0.15), brick = col(PAL.brick), lead = col('#938e8a');
    for (let i = 0; i < 3; i++) { // three halls, the middle one taller, each with a vent along the ridge
      const fi = (a, b, c) => f(a, b, c + (i - 1) * 0.16), hh = i === 1 ? 0.16 : 0.13;
      box(g, ID, fi, 0.5, hh, 0.15, { wall: jit(brick, 0.04), wallSt: 1, top: brick });
      hipRoof(g, ID, (a, b, c) => fi(a, b + hh, c), 0.5, 0.15, 0.06, lead, true, brick);
      box(g, ID, (a, b, c) => fi(a, b + hh + 0.045, c), 0.34, 0.03, 0.03, { wall: shade(lead, 0.8), wallSt: 0, top: shade(lead, 1.08) });
    }
    const fc = (a, b, c) => f(a + 0.34, b, c + 0.12);
    box(g, ID, fc, 0.12, 0.07, 0.12, { wall: shade(brick, 0.96), wallSt: 0, top: brick }); // plinth
    cylinder(g, ID, fc, 0.05, 0.85, 10, brick, col('#6f5a50'), 0, 0.037);
    for (const y of [0.3, 0.58]) cylinder(g, ID, (a, b, c) => fc(a, b + y, c), 0.05 - 0.013 * y / 0.85 + 0.004, 0.014, 10, shade(brick, 0.9), null, 0);
    cylinder(g, ID, (a, b, c) => fc(a, b + 0.82, c), 0.046, 0.04, 10, shade(brick, 0.9), col('#6f5a50'), 0, 0.044); // corbelled cap
    chimneyTop = [...fc(0, 0.86, 0)];
  });
  const lightTh = 2.38, lr = coast(lightTh) - 0.06;
  place([rx * lr * Math.cos(lightTh), rz * lr * Math.sin(lightTh)], 0.3, (x, z) => { // lighthouse
    const f = X(x, 0, z), white = col('#f4f0e8'), red = col('#c27560');
    cylinder(g, ID, f, 0.06, 0.2, 10, white, null, 0, 0.052);
    cylinder(g, ID, (a, b, c) => f(a, b + 0.2, c), 0.052, 0.07, 10, red, null, 0, 0.048);
    cylinder(g, ID, (a, b, c) => f(a, b + 0.27, c), 0.048, 0.12, 10, white, null, 0, 0.042);
    cylinder(g, ID, (a, b, c) => f(a, b + 0.39, c), 0.036, 0.05, 8, col('#b9c9c9'), null, 0);
    cone(g, ID, (a, b, c) => f(a, b + 0.44, c), 0.05, 0.06, 8, red);
  });

  // avenues lined with trees, planted before the lots so the blocks make room
  const TR = PAL.trees;
  for (const road of roads) {
    for (let i = 0; i < road.length - 1; i += 4) {
      const a = road[i], b = road[i + 1], t = norm([b[0] - a[0], 0, b[1] - a[1]]);
      for (const k of [-1, 1]) {
        const x = a[0] - t[2] * 0.105 * k, z = a[1] + t[0] * 0.105 * k, r = rnd(0.042, 0.058);
        if (rand() < 0.8 && landS(x, z) > 0.12 && waterS(x, z) > 0.06 && viaD(x, z) > 0.13 && Math.abs(hillD(x, z)) > 0.08 && roadD(x, z) > 0.085 && occ.free(x, z, r * 1.5)) {
          occ.add({ x, z, r: r * 1.5 }); tree(g, ID, x, hillH(x, z) - 0.01, z, r, pick(TR), true);
        }
      }
    }
  }

  // ordinary lots by dart throwing
  const radius = { dt: 0.34, old: 0.13, res: 0.165, ind: 0.25 };
  for (let k = 0; k < 240000; k++) {
    const x = rnd(-rx, rx), z = rnd(-rz, rz), zone = zoneAt(x, z), r = radius[zone] * rnd(0.88, 1.12);
    if (!ok(x, z, r)) continue;
    if (zone !== 'dt' && parkMask(x, z) > 0.4) continue;
    if (!occ.free(x, z, r)) continue;
    occ.add({ x, z, r });
    const base = zone === 'old' ? 0.4 : 0.15 + 0.3 * (fbm(x * 0.2 + 1, z * 0.2 + 2) - 0.5);
    const ang = faceAngle(x, z, base) + (zone === 'old' ? rnd(-0.12, 0.12) : rnd(-0.03, 0.03));
    const f = X(x, hillH(x, z), z, ang);
    if (zone === 'dt') {
      const dd = Math.hypot(x - DT[0], z - DT[1]), hMax = 0.35 + 2.2 * Math.exp(-dd * dd / 0.8);
      const h = hMax * rnd(0.5, 1.0);
      if (h > 0.55) tower(g, ID, f, r * rnd(0.42, 0.54), h, rand() < 0.45);
      else { const s = r * rnd(0.64, 0.78); block(g, ID, f, s, s * rnd(0.75, 1), h); }
    } else if (zone === 'old') {
      house(g, ID, f, r * rnd(0.62, 0.76), r * rnd(0.52, 0.66), rnd(0.1, 0.2), 0.92);
    } else if (zone === 'ind') {
      const brick = jit(rand() < 0.5 ? col(PAL.brick) : col('#dad2c4'), 0.05);
      box(g, ID, f, r * 0.8, 0.13, r * 0.5, { wall: brick, wallSt: 1, top: brick });
      hipRoof(g, ID, (a, b, c) => f(a, b + 0.13, c), r * 0.8, r * 0.5, 0.05, col('#9c9690'), true, brick);
    } else if (rand() < 0.5) {
      house(g, ID, f, r * rnd(0.6, 0.72), r * rnd(0.5, 0.64), rnd(0.1, 0.22), 0.45);
    } else {
      house(g, ID, f, r * rnd(0.6, 0.72), r * rnd(0.54, 0.66), rnd(0.2, 0.42), 0.3);
    }
  }
  // a gravel path circles the pond, broken where roads and the hall meet it
  {
    const PATH = col('#ddd6c6'), hw = 0.016, R = pond.r + 0.13, pts = [];
    for (let i = 0; i < 90; i++) {
      const a0 = i / 90 * TAU, a1 = (i + 1) / 90 * TAU, a = [pond.x + R * Math.cos(a0), pond.z + R * Math.sin(a0)], b = [pond.x + R * Math.cos(a1), pond.z + R * Math.sin(a1)];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      if (roadD(mx, mz) < 0.1 || viaD(mx, mz) < 0.13 || !occ.free(mx, mz, 0.03)) continue;
      const t = norm([b[0] - a[0], 0, b[1] - a[1]]), nx = -t[2] * hw, nz = t[0] * hw;
      g.quad(ID, [a[0] - nx, 0.003, a[1] - nz], [a[0] + nx, 0.003, a[1] + nz], [b[0] + nx, 0.003, b[1] + nz], [b[0] - nx, 0.003, b[1] - nz], PATH, 3, [a[0], a[1]], [a[0], a[1]], [b[0], b[1]], [b[0], b[1]], [mx, -1, mz]);
      for (const k of [-1, 1]) g.seg(ID, [a[0] + k * nx, 0.003, a[1] + k * nz], [b[0] + k * nx, 0.003, b[1] + k * nz]);
      pts.push([mx, mz]);
    }
    for (const [x, z] of pts) occ.add({ x, z, r: 0.07 });
  }
  // trees: river banks, parks, the shore, then a sprinkle between houses
  const treeOk = (x, z, r) => landS(x, z) > 0.06 && waterS(x, z) > 0.05 && roadD(x, z) > 0.07 + r * 0.8 && viaD(x, z) > 0.1 + r && Math.abs(hillD(x, z)) > 0.08 && occ.free(x, z, r * 1.6);
  const addTree = (x, z, r) => { occ.add({ x, z, r: r * 1.6 }); tree(g, ID, x, hillH(x, z) - 0.01, z, r, pick(TR)); };
  for (let k = 0; k < 50000; k++) {
    const x = rnd(-rx, rx), z = rnd(-rz, rz), w = waterS(x, z), r = rnd(0.07, 0.11);
    if (w > 0.05 && w < 0.26 && treeOk(x, z, r) && rand() < 0.9) addTree(x, z, r);
  }
  // in the parks, groves stand close and the open lawns hold a few trees apart
  const spacing = (x, z) => 1 + 0.9 * smooth(0.5, 0.42, fbm(x * 1.1 + 17, z * 1.1 + 5, 3));
  for (let k = 0; k < 50000; k++) {
    const x = rnd(-rx, rx), z = rnd(-rz, rz), r = rnd(0.08, 0.125), s = spacing(x, z);
    if (parkMask(x, z) > 0.5 && treeOk(x, z, r * s)) { occ.add({ x, z, r: r * 1.6 * s }); tree(g, ID, x, hillH(x, z) - 0.01, z, r, pick(TR)); }
  }
  for (let j = 0; j < J; j++) {
    if (rand() < 0.45) {
      const th = j / J * TAU, rho = coast(th) - rnd(0.01, 0.04), x = rx * rho * Math.cos(th), z = rz * rho * Math.sin(th), r = rnd(0.05, 0.085);
      if (waterS(x, z) > 0.05 && roadD(x, z) > 0.06 + r && occ.free(x, z, r * 1.4)) { occ.add({ x, z, r: r * 1.4 }); tree(g, ID, x, -0.02, z, r, pick(TR), true); }
    }
  }
  for (let k = 0; k < 70000; k++) {
    const x = rnd(-rx, rx), z = rnd(-rz, rz), r = rnd(0.055, 0.095);
    if (parkMask(x, z) <= 0.5 && treeOk(x, z, r)) addTree(x, z, r);
  }
  // greenery along the rim: shrubs spill over it, small trees stand at its
  // edge, and tufts cling to the cliff below
  for (let j = 0; j < J; j++) {
    if (rand() < 0.5) {
      const th = (j + rnd(0, 1)) / J * TAU, out = rnd(-0.004, 0.012), rho = coast(th) * (1 + out);
      const x = rx * rho * Math.cos(th), z = rz * rho * Math.sin(th);
      if (waterS(x * 0.97, z * 0.97) < 0.1 || roadD(x, z) < 0.06) continue;
      g.crowns.push({ W: ID, x, y: rnd(-0.04, 0.04) - Math.max(out, 0) * 4, z, r: rnd(0.035, 0.06), sy: rnd(0.65, 0.9), rot: rnd(0, TAU), c: shade(pick(TR), rnd(0.84, 0.96)), v: Math.floor(rand() * CROWN_VARIANTS) });
    }
    if (rand() < 0.35) {
      const th = (j + rnd(0, 1)) / J * TAU, rho = coast(th) * (1 - rnd(0, 0.008)), r = rnd(0.05, 0.075);
      const x = rx * rho * Math.cos(th), z = rz * rho * Math.sin(th);
      if (waterS(x * 0.97, z * 0.97) < 0.1 || roadD(x, z) < 0.06 + r || !occ.free(x, z, r * 1.3)) continue;
      occ.add({ x, z, r: r * 1.3 }); tree(g, ID, x, -0.02, z, r, pick(TR), true);
    }
    if (rand() < 0.3) {
      const th = (j + rnd(0, 1)) / J * TAU, rho = coast(th) * (1 + rnd(0.01, 0.018));
      const x = rx * rho * Math.cos(th), z = rz * rho * Math.sin(th);
      if (waterS(x * 0.97, z * 0.97) < 0.1) continue;
      g.crowns.push({ W: ID, x, y: rnd(-0.13, -0.05), z, r: rnd(0.025, 0.042), sy: rnd(0.6, 0.8), rot: rnd(0, TAU), c: shade(pick(TR), rnd(0.8, 0.92)), v: Math.floor(rand() * CROWN_VARIANTS) });
    }
  }
  // piers on the harbour's east shore, some with a head, and boats tied up alongside
  const PIER = col('#ddd3bf'), PIER_SIDE = col('#b9ab92'), HULL = col('#f3efe6'), CABIN = col('#c27a5f');
  for (let i = 0; i < 5; i++) {
    const z = LK.z - 0.45 + i * 0.22;
    let x = LK.x + LK.rx * 1.3; while (x > LK.x && waterS(x, z) > -0.02) x -= 0.02;
    const pl = 0.36 + 0.06 * (i % 2), x1 = x - pl + 0.06;
    box(g, ID, X(x - pl / 2 + 0.06, -0.045, z, 0), pl, 0.05, 0.052, { wall: PIER_SIDE, wallSt: 4, top: PIER });
    if (i % 2 === 0) box(g, ID, X(x1 + 0.03, -0.045, z, 0), 0.06, 0.05, 0.13, { wall: PIER_SIDE, wallSt: 4, top: PIER });
    if (i !== 2) { // a moored boat
      const f = X(x1 + 0.13 + 0.04 * (i % 2), -0.035, z + (i < 2 ? 0.075 : -0.075), 0.04 * (i - 2));
      box(g, ID, f, 0.15, 0.03, 0.05, { wall: HULL, wallSt: 0, top: HULL });
      box(g, ID, (a, b, c) => f(a - 0.02, b + 0.03, c), 0.05, 0.03, 0.036, { wall: CABIN, wallSt: 0, top: CABIN });
    }
  }
  // outcrops: boulders heaped at points along the shore, standing out past the rim
  {
    const keep = rand, tpls = [rockTemplate(1), rockTemplate(2), rockTemplate(3, ICO1)];
    reseed(47);
    for (let j = 0; j < J; j += 3) {
      const th = (j + rnd(0, 3)) / J * TAU, c0 = coast(th), x0 = rx * c0 * Math.cos(th), z0 = rz * c0 * Math.sin(th);
      if (rand() > 0.55 || rocky(x0, z0) < 1.0 || waterS(x0, z0) < 0.08) continue;
      const nx = Math.cos(th), nz = Math.sin(th), n = 3 + Math.floor(rnd(0, 5));
      for (let k = 0; k < n; k++) {
        const r0 = rnd(0.06, 0.13), out = rnd(-0.05, r0), along = rnd(-0.18, 0.18), r = r0 * (1 - 2 * Math.max(0, -out));
        const x = x0 + nx * out - nz * along, z = z0 + nz * out + nx * along;
        if (waterS(x, z) < 0.04) continue;
        boulder(g, ID, X(x, sit(x, z, rnd(-0.24, -0.14) - out * 0.4), z, rnd(0, TAU)), r, rnd(0.6, 0.9), jit(RK, 0.08), 0.08, mossy(x, z), pick(tpls));
      }
    }
    rand = keep;
  }

  const lakePath = [];
  for (let i = 0; i < 120; i++) { const t = i / 120 * TAU; lakePath.push([LK.x - 0.15 + LK.rx * 0.45 * Math.cos(t), LK.z + LK.rz * 0.5 * Math.sin(t)]); }
  return { g, wg, VF, VW, SHED, chimneyTop, lakePath, land: landS.grid };
}

// ------------------------------------------------------------ the knot's motion
// Each term is [amplitude, frequency along the knot, speed, phase]. Frequencies
// are integers so the curve stays closed; they are chosen apart from p and q so
// neighbouring lobes move out of step. The same table drives the vertex shader
// and the JS used to place trains, so both agree exactly.

const MOTION = {
  dr: [[0.09, 7, -0.23, 2.3], [0.05, 11, 0.31, 0.0]], // swelling waves that travel along the strands
  dR: [[0.03, 4, 0.19, 0.7]], // the ring breathes in and out
  dph: [[0.015, 2, 0.21, 0.3]], // strands slide along the ring
  dth: [[0.04, 4, -0.17, 1.1], [0.02, 7, 0.13, 2.0]], // strands slide around the tube
  dz: [[0.12, 2, 0.15, 4.0], [0.05, 8, -0.27, 1.3]], // the layers of the knot part and close
  psi: [[0.13, 3, 0.2, 0.5], [0.05, 8, -0.33, 2.2]], // each strand rolls about its own axis
};
// The resting knot is not quite regular: its lobes swell and stand up by
// different amounts. Frequencies 1 and 2 break the four-fold symmetry; the
// tube swells about its inner equator, so the crowded middle keeps its gaps.
const REST = {
  dr: [[0.08, 1, 0, 0.3], [0.05, 2, 0, 5.2]],
  dz: [[0.08, 1, 0, 2.2], [0.05, 3, 0, 0.3]],
};
const f4 = (x) => x.toFixed(4);
const termsGLSL = (list) => '(' + list.map(([A, k, s, ph]) => `${f4(A)} * sin(${f4(k)} * w + ${f4(s)} * t + ${f4(ph)})`).join(' + ') + ')';
const termsJS = (list, w, t) => { let v = 0; for (const [A, k, s, ph] of list) v += A * Math.sin(k * w + s * t + ph); return v; };
const KEPS = 1 / 4096;
const SPINE_N = 4096; // shared samples of the knot frame, interpolated by its vertices

function knotMotion(spec, cacheSpine = false) {
  const { p, q, R, r, zs } = spec;
  function curve(u, t, a, core) {
    const w = TAU * u;
    const dr = a * termsJS(MOTION.dr, w, t) + termsJS(REST.dr, w, 0), rr = r * (1 + dr);
    const RR = R + r * dr + R * a * termsJS(MOTION.dR, w, t);
    const ph = p * w + a * termsJS(MOTION.dph, w, t);
    const th = q * w + a * termsJS(MOTION.dth, w, t);
    const zz = zs * (1 + a * termsJS(MOTION.dz, w, t) + termsJS(REST.dz, w, 0));
    const cr = RR + rr * Math.cos(th);
    if (core) { core[0] = RR * Math.cos(ph); core[1] = RR * Math.sin(ph); core[2] = 0; }
    return [cr * Math.cos(ph), cr * Math.sin(ph), zz * rr * Math.sin(th)];
  }
  const c0 = [0, 0, 0];
  function frame(u, t, a) {
    const P = curve(u, t, a, c0);
    const T = norm(sub(curve(u + KEPS, t, a), curve(u - KEPS, t, a)));
    const D = sub(P, c0);
    let N = norm(sub(D, scl(T, dot(D, T)))), B = cross(T, N);
    const psi = a * termsJS(MOTION.psi, TAU * u, t), cs = Math.cos(psi), sn = Math.sin(psi);
    [N, B] = [add(scl(N, cs), scl(B, sn)), sub(scl(B, cs), scl(N, sn))];
    return { P, T, N, B };
  }
  // the analytic frame, evaluated once per frame at SPINE_N points along the
  // curve by the spine pass; vertices read it back from that texture
  const spineGlsl = /* glsl */`
uniform float uTime;
uniform float uAlive;
vec3 kCurve(float u, out vec3 core) {
  float w = 6.28318530718 * u, t = uTime, a = uAlive;
  float dr = a * ${termsGLSL(MOTION.dr)} + ${termsGLSL(REST.dr)};
  float rr = ${f4(r)} * (1.0 + dr);
  float RR = ${f4(R)} + ${f4(r)} * dr + ${f4(R)} * a * ${termsGLSL(MOTION.dR)};
  float ph = ${f4(p)} * w + a * ${termsGLSL(MOTION.dph)};
  float th = ${f4(q)} * w + a * ${termsGLSL(MOTION.dth)};
  float zz = ${f4(zs)} * (1.0 + a * ${termsGLSL(MOTION.dz)} + ${termsGLSL(REST.dz)});
  float cr = RR + rr * cos(th);
  core = vec3(RR * cos(ph), RR * sin(ph), 0.0);
  return vec3(cr * cos(ph), cr * sin(ph), zz * rr * sin(th));
}
void kFrame(float u, out vec3 P, out vec3 T, out vec3 N, out vec3 B) {
  vec3 c, c1;
  P = kCurve(u, c);
  T = normalize(kCurve(u + ${KEPS.toFixed(10)}, c1) - kCurve(u - ${KEPS.toFixed(10)}, c1));
  vec3 D = P - c;
  N = normalize(D - dot(D, T) * T);
  B = cross(T, N);
  float w = 6.28318530718 * u, t = uTime;
  float psi = uAlive * ${termsGLSL(MOTION.psi)};
  float cs = cos(psi), sn = sin(psi);
  vec3 N2 = cs * N + sn * B;
  B = cs * B - sn * N;
  N = N2;
}
`;
  const glsl = /* glsl */`
uniform float uTime;
uniform float uAlive;
uniform sampler2D tSpine;
varying float vKAO;
void kFrame(float u, out vec3 P, out vec3 T, out vec3 N, out vec3 B) {
  float x = fract(u) * ${SPINE_N}.;
  int i0 = int(x) % ${SPINE_N}, i1 = (i0 + 1) % ${SPINE_N};
  float f = x - floor(x);
  P = mix(texelFetch(tSpine, ivec2(i0, 0), 0).xyz, texelFetch(tSpine, ivec2(i1, 0), 0).xyz, f);
  T = normalize(mix(texelFetch(tSpine, ivec2(i0, 1), 0).xyz, texelFetch(tSpine, ivec2(i1, 1), 0).xyz, f));
  N = mix(texelFetch(tSpine, ivec2(i0, 2), 0).xyz, texelFetch(tSpine, ivec2(i1, 2), 0).xyz, f);
  N = normalize(N - dot(N, T) * T);
  B = cross(T, N);
}
`;
  const spineFrag = spineGlsl + /* glsl */`
void main() { // texel (i, row): row 0 P, 1 T, 2 N, 3 B of the frame at u = i / SPINE_N
  vec3 P, T, N, B;
  kFrame((gl_FragCoord.x - .5) / ${SPINE_N}., P, T, N, B);
  int row = int(gl_FragCoord.y);
  gl_FragColor = vec4(row == 0 ? P : row == 1 ? T : row == 2 ? N : B, 1.);
}
`;
  return { curve, frame, glsl: cacheSpine ? glsl : spineGlsl + 'varying float vKAO;\n', spineFrag, spine: { value: null }, far: R + r };
}

// ------------------------------------------------------------ the knot

function buildKnot(spec) {
  reseed(29);
  const { q, width: Wd, height: Hb } = spec;
  const n = 4096, pts = [], cores = [], rest = knotMotion(spec).curve;
  for (let i = 0; i < n; i++) { const c = [0, 0, 0]; pts.push(rest(i / n, 0, 0, c)); cores.push(c); }
  // Only the resting curve's arc length is used here: geometry is laid out
  // along a straight street and stored as (u, height, across) for the GPU.
  const F = makeFrames(pts, true, (i, P) => sub(P, cores[i]));
  const L = F.L;
  // the strands are broader round the outside of the ring than in its crowded middle
  const wide = (u) => 1 + 0.1 * Math.cos(q * TAU * u) + 0.04 * Math.sin(5 * TAU * u + 1.3);
  const KW = {
    p: (x, y, z) => { const u = F.u(x); return [u, y, z * wide(u)]; },
    n: (x, y, z, a, b, c) => norm([a, b, c / wide(F.u(x))]),
  };
  const g = new Geo();
  const half = Wd / 2, ts = 0.075, tw = 0.045, rec = 0.03;
  const ST = col(PAL.stone), GR = col(PAL.ground);
  const DK = mixc(col(PAL.deck), col(PAL.park), 0.3); // gardens between the houses
  sweepBox(g, KW, 0, L, -half, half, Hb / 2 - ts, Hb / 2, { top: [DK, 3], bottom: [shade(ST, 0.5), 4], left: [ST, 4], right: [ST, 4] }, 0.06);
  sweepBox(g, KW, 0, L, -half, half, -Hb / 2, -Hb / 2 + ts, { top: [col(PAL.canal), 0], bottom: [DK, 3], left: [ST, 4], right: [ST, 4] }, 0.06);
  // one tier of tall arches under the road, like a viaduct
  const Hw = Hb - 2 * ts;
  const nSp = Math.round(L / 0.4), S = L / nSp;
  const big = archPanel(S, Hw, S * 0.36, Hw * 0.5, tw, 10);
  for (const side of [-1, 1]) {
    const ac = side * (half - rec - tw / 2);
    for (let i = 0; i < nSp; i++) addTemplate(g, KW, big, (x, y, z) => [i * S + x, -Hb / 2 + ts + y, ac - tw / 2 + z], jit(ST, 0.03), 4, (pp) => [i * S + pp[0], pp[1]]);
  }
  const lane = [0.17, 0.55]; // the road runs along one rim of each face, over the arcade
  deckStreet(g, faceWarp(KW, Hb / 2, false), L, Wd, lane, 1.0);
  deckStreet(g, faceWarp(KW, Hb / 2, true), L, Wd, lane, 0.7);
  deckVerge(g, faceWarp(KW, Hb / 2, false), L, Wd); // outer face only: on the inner face the strands crowd too close
  // crowns in street coordinates: (u, height, across, face) and (r, r*sy, turn, du/ds)
  const I0 = new Float32Array(g.crowns.length * 4), I1 = new Float32Array(g.crowns.length * 4), IC = new Float32Array(g.crowns.length * 3), IV = new Uint8Array(g.crowns.length);
  g.crowns.forEach((c, i) => {
    let du = F.u(c.x + 0.02) - F.u(c.x - 0.02); if (du < 0) du += 1;
    I0.set([F.u(c.x), c.W.h + c.y, c.z * wide(F.u(c.x)), c.W.flip ? -1 : 1], i * 4);
    I1.set([c.r, c.r * c.sy, c.rot, du / 0.04], i * 4);
    IC.set(c.c, i * 3); IV[i] = c.v;
  });
  return { g, F, L, lane, Hb, wide, crowns: { I0, I1, IC, IV } };
}

// Runs of shrubs hang over the parapets, as the painted strands have them.
// Placed from hashes, so the deck's random stream is left alone.
function deckVerge(g, W, L, Wd) {
  const TR = PAL.trees, f = W.flip ? 1 : 0;
  for (let i = 0; i * 0.05 < L; i++) {
    for (const side of [-1, 1]) {
      const s = i * 0.05, h = hash2(i * 3 + f, side + 40), run = smooth(0.58, 0.72, vnoise(s * 1.4 + side * 11 + f * 5, 3.7));
      if (h > run * 0.8) continue;
      const h2 = hash2(i + 900, side * 3 + f), h3 = hash2(i + 1700, side * 5 + f);
      g.crowns.push({ W, x: s + 0.02 * (h2 - 0.5), y: -0.035 - 0.04 * h3, z: side * (Wd / 2 + 0.004 + 0.012 * h2), r: 0.03 + 0.018 * h3, sy: 0.75 + 0.2 * h2,
        rot: h * TAU, c: shade(TR[Math.floor(h2 * TR.length)], 0.86 + 0.1 * h3), v: Math.floor(h3 * CROWN_VARIANTS) });
    }
  }
}

function deckStreet(g, W, L, Wd, lane, towerRate) {
  const half = Wd / 2, ST = col(PAL.stone), RD = col(PAL.lane), KB = col('#dedad2');
  for (const a of [-half, half - 0.016]) sweepBox(g, W, 0, L, a, a + 0.016, 0, 0.024, { top: [ST, 0], left: [ST, 4], right: [ST, 4] }, 0.08, 'top');
  sweepBox(g, W, 0, L, lane[0], lane[1], 0, 0.003, { top: [RD, 0] }, 0.08, 'top');
  sweepBox(g, W, 0, L, lane[0] - 0.02, lane[0], 0, 0.02, { top: [KB, 0], left: [KB, 4], right: [KB, 4] }, 0.08, 'top'); // kerb between road and houses
  const lc = (lane[0] + lane[1]) / 2 + 0.05; // the rails run in the right-hand lane
  for (let s = 0; s < L; s += 0.08) for (const d of [-0.017, 0.017]) g.seg(W, [s, 0.005, lc + d], [s + 0.08, 0.005, lc + d]);
  const mid = (lane[0] + lane[1]) / 2;
  for (let s = 0; s < L; s += 0.1) g.seg(W, [s, 0.005, mid], [s + 0.045, 0.005, mid]); // centre line
  for (const d of [lane[0] + 0.014, lane[1] - 0.014]) for (let s = 0; s < L; s += 0.16) g.seg(W, [s, 0.005, d], [s + 0.16, 0.005, d]);
  for (const a of [-half + 0.008, half - 0.008]) { // railings: a handrail and posts
    for (let s = 0; s < L; s += 0.1) g.seg(W, [s, 0.05, a], [s + 0.1, 0.05, a]);
    for (let s = 0; s < L; s += 0.05) g.seg(W, [s, 0.024, a], [s, 0.05, a]);
  }
  const TR = PAL.trees;
  const b0 = -half + 0.045, b1 = lane[0] - 0.035, c0 = lane[1] + 0.015, c1 = half - 0.02;
  const hMax = W.flip ? 0.18 : 0.24; // lower on the inner face, where strands crowd
  const bands = [[b0, b1], [c0, c1]].filter(([lo, hi]) => hi - lo > 0.12).map(([lo, hi]) => [lo, hi, Math.max(1, Math.round((hi - lo) / 0.24))]);
  for (const [lo, hi, rows] of bands) {
    const depth = (hi - lo) / rows;
    for (let row = 0; row < rows; row++) {
      const ac = lo + (row + 0.5) * depth;
      const dome = 0.7 + 0.4 * (1 - Math.abs(2 * (row + 0.5) / rows - 1)); // taller down the middle, so each strand reads round
      let s = rnd(0, 0.06);
      while (s < L - 0.22) {
        const len = rnd(0.08, 0.22), r = rand();
        if (r < 0.3) {
          const nT = 1 + Math.floor(rand() * 3);
          for (let k = 0; k < nT; k++) tree(g, W, s + rnd(0.03, len - 0.03), -0.004, ac + rnd(-depth, depth) * 0.3, rnd(0.055, 0.095), pick(TR));
        } else if (r > 0.32) {
          const dep = depth * rnd(0.66, 0.94), f = X(s + len / 2, 0, ac + rnd(-0.5, 0.5) * (depth - dep), 0);
          if (rand() < 0.06 * towerRate) {
            box(g, W, f, len * 0.7, rnd(1.15, 1.65) * hMax * (W.flip ? 0.7 : 1), dep * 0.85, { wall: jit(pick(PAL.glass)), wallSt: 2, top: jit(pick(PAL.flat)) });
          } else {
            house(g, W, f, len, dep, rnd(0.1, hMax) * dome, 0.45);
          }
        }
        s += len + rnd(0.004, 0.014);
      }
    }
  }
}

// ------------------------------------------------------------ materials

const LAND_FADE = `uniform sampler2D uLand;
uniform vec4 uLandA;
uniform vec3 uBlend;
// how much of the painting survives at island point p (t: its place in the land texture)
uniform float uIntro;  // seconds into the first appearance; large once it is over
// how far the wash has spread from downtown by time t, and whether it has reached p
float ckEase(float k) { k = clamp(k, 0., 1.); return k < .5 ? 4. * k * k * k : 1. - pow(2. - 2. * k, 3.) * .5; } // slow start, then it gathers pace, then settles
float bloomFront(float t) { return 9.5 * ckEase(t / 3.7); }
float introBloom(vec2 xz) {
  if (uIntro > 30.) return 1.;
  float d = length(xz - vec2(1.35, -1.75)) + 1.1 * (ckFbm(xz * .9 + 2.) - .5) + .3 * (ckNoise(xz * 5.) - .5);
  return smoothstep(0., .22, bloomFront(uIntro) - d);
}
float landFade(vec3 p, vec2 t) {
  float inland = texture2D(uLand, t).r * 1.5;
  float l = inland + .5 * (ckFbm(p.xz * 1.15 + 3.1) - .5) + .14 * (ckNoise(p.xz * 7.3 + 1.) - .5);
  // a ragged edge where the wash stops, then a thinner wash just inside it
  float f = .62 * smoothstep(uBlend.y, uBlend.y + .07, l) + .38 * smoothstep(uBlend.y + .12, uBlend.z, l);
  f *= smoothstep(.03, .1, inland); // the shore rocks themselves always drop out
  f *= mix(smoothstep(.7, 1., inland), 1., smoothstep(-.1, -.045, p.y)); // cliff faces below the coast drop out
  return mix(1., f, uBlend.x) * introBloom(p.xz);
}
`;

const GLSL_COMMON = /* glsl */`
varying float vStyle;
varying vec2 vWall;
varying vec3 vLocal;
uniform float uTime;
float ckHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float ckNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f);
  return mix(mix(ckHash(i), ckHash(i + vec2(1, 0)), u.x), mix(ckHash(i + vec2(0, 1)), ckHash(i + vec2(1, 1)), u.x), u.y);
}
float ckFbm(vec2 p) { float s = 0., a = .5; for (int i = 0; i < 4; i++) { s += a * ckNoise(p); p *= 2.03; a *= .5; } return s / .9375; }
float ckBand(float x, float a, float b, float fw) { return smoothstep(a - fw, a + fw, x) * (1. - smoothstep(b - fw, b + fw, x)); }
`;

const GLSL_STYLE = /* glsl */`
float ckInk = 0.;
// a crisp outline of the box [lo, hi] in cell space, about one pixel wide
float ckFrame(vec2 f, vec2 lo, vec2 hi, float fw) {
  float w = fw * .9;
  float outer = ckBand(f.x, lo.x - w, hi.x + w, fw * .5) * ckBand(f.y, lo.y - w, hi.y + w, fw * .5);
  float inner = ckBand(f.x, lo.x, hi.x, fw * .5) * ckBand(f.y, lo.y, hi.y, fw * .5);
  return clamp(outer - inner, 0., 1.);
}
vec3 ckStylize(vec3 col) {
  int st = int(vStyle + .5);
  if (st == 1) { // plastered wall with framed windows and shopfronts
    vec2 g = vWall / vec2(.046, .056), f = fract(g), id = floor(g);
    float fw = max(fwidth(g.x), fwidth(g.y)), far = clamp(fw * 1.4 - .35, 0., 1.), fine = 1. - smoothstep(.12, .3, fw);
    float upper = step(.85, g.y);
    float win = ckBand(f.x, .3, .7, fw) * ckBand(f.y, .3, .78, fw) * upper;
    float frame = ckBand(f.x, .24, .76, fw) * ckBand(f.y, .24, .84, fw) * upper - win;
    float shop = (1. - upper) * ckBand(f.x, .1, .9, fw) * ckBand(f.y, .12, .8, fw);
    float v = ckHash(id + floor(vLocal.xz * 3.) * 7.13);
    vec3 glass = mix(vec3(.34, .39, .46), vec3(.58, .62, .66), v * v);
    col *= .92 + .11 * ckFbm(vWall * vec2(7., 5.) + vLocal.xz * 2.3);
    col *= 1. - .1 * (1. - smoothstep(0., .05, vWall.y));
    vec3 c = col;
    c = mix(c, c * 1.06 + .02, frame * .8);
    c = mix(c, glass * (c * .5 + .5), win * .9);
    c = mix(c, c * vec3(.42, .44, .48), shop * .75);
    col = mix(c, mix(col, col * vec3(.72, .76, .8), .22), far);
    float sill = ckBand(f.y, .24 - fw, .26, fw * .5) * ckBand(f.x, .24, .76, fw) * upper;
    ckInk = fine * max(max(ckFrame(f, vec2(.3), vec2(.7, .78), fw) * upper, sill), ckFrame(f, vec2(.1, .12), vec2(.9, .8), fw) * (1. - upper)) * .6;
  } else if (st == 2) { // curtain wall
    vec2 g = vWall / vec2(.036, .046), f = fract(g), id = floor(g);
    float fw = max(fwidth(g.x), fwidth(g.y)), far = clamp(fw * 1.4 - .35, 0., 1.), fine = 1. - smoothstep(.12, .3, fw);
    float mull = max(1. - ckBand(f.x, .1, .9, fw), 1. - ckBand(f.y, .12, .9, fw));
    float sky = smoothstep(0., 2.8, vWall.y);
    float pane = ckHash(id + floor(vLocal.xz * 5.) * 3.1);
    vec3 c = col * (.82 + .2 * sky + .12 * pane);
    c += .05 * smoothstep(.55, .95, ckNoise(vWall * vec2(1.3, .5) + vLocal.xz));
    c = mix(c, col * 1.2 + .05, mull * .6);
    col = mix(c, col * (.9 + .2 * sky) + .02, far);
    ckInk = fine * (1. - ckBand(f.x, fw * .8, 1. - fw * .8, fw * .4) * ckBand(f.y, fw * .8, 1. - fw * .8, fw * .4)) * .3;
  } else if (st == 3) { // ground: grass, dust, paving
    float n = ckFbm(vWall * 1.7), m = ckFbm(vWall * 6.3 + 4.1);
    col = mix(col, col * vec3(.84, .94, .74), smoothstep(.5, .78, n) * .7);
    col = mix(col, col * vec3(1.04, 1., .93), smoothstep(.55, .8, m) * .5);
    col *= .93 + .12 * ckNoise(vWall * 31.) * ckNoise(vWall * 9. + 2.);
  } else if (st == 4) { // dressed stone in courses
    vec2 b = vWall / vec2(.07, .032);
    b.x += .5 * mod(floor(b.y), 2.);
    vec2 fb = fract(b);
    float fw = max(fwidth(b.x), fwidth(b.y)), fine = 1. - smoothstep(.15, .35, fw);
    float joint = max(1. - ckBand(fb.x, .04, .96, fw), 1. - ckBand(fb.y, .08, .92, fw));
    joint *= 1. - clamp(fw * 1.2 - .3, 0., 1.);
    col *= .9 + .12 * ckHash(floor(b));
    col *= 1. - .12 * joint;
    col *= .94 + .1 * ckFbm(vWall * vec2(5., 9.));
    ckInk = fine * (1. - ckBand(fb.y, fw * .7, 1. - fw * .7, fw * .4)) * .28;
  } else if (st == 5) { // clay tiles
    float fw = fwidth(vWall.y / .045), fine = 1. - smoothstep(.15, .35, fw);
    float row = fract(vWall.y / .045);
    col *= 1. - .16 * ckBand(row, 0., .24, fw) * (1. - clamp(fw - .4, 0., 1.));
    float m = ckFbm(vLocal.xz * 16. + vWall.y * 4.);
    col = mix(col * vec3(1.05, .96, .9), col * vec3(.9, .95, .97), m);
    col *= .9 + .18 * ckNoise(vLocal.xz * 120. + vWall.y * 30.);
    ckInk = fine * (1. - ckBand(row, fw * .8, 1., fw * .4)) * .38;
  } else if (st == 6) { // rock with strata and cracks
    col *= .8 + .32 * ckFbm(vLocal.xz * 7. + vLocal.y * 11.);
    col *= 1. - .12 * smoothstep(.6, .9, ckNoise(vec2(vLocal.y * 40., vLocal.x * 3. + vLocal.z * 3.)));
    float cr = abs(ckFbm(vLocal.xz * 9. + vLocal.y * 13.) - .5);
    ckInk = (1. - smoothstep(0., .035, cr)) * .45;
  } else if (st == 8) { // gravel roof
    col *= .9 + .16 * ckNoise(vWall * 90.) * ckNoise(vWall * 23. + 3.);
    col *= .95 + .08 * ckFbm(vWall * 11.);
  } else if (st == 7) { // leaves
    float n = ckFbm(vWall * 6.5), d = ckNoise(vWall * 21.);
    col *= .68 + .5 * smoothstep(.2, .85, n);
    col = mix(col, col * vec3(1.12, 1.1, .82), smoothstep(.62, .92, d) * .45);
    float shadeSide = 1. - smoothstep(.2, .55, dot(col, vec3(.33)));
    ckInk = smoothstep(.66, .74, ckNoise(vWall * 34.)) * (.2 + .45 * shadeSide);
  } else if (st == 9) { // road: grey asphalt, a pale kerb and an inked edge; vWall = (kerb weight, across -1..1)
    float a = abs(vWall.y), fw = fwidth(vWall.y), k = clamp(vWall.x, 0., 1.) * (1. - smoothstep(.16, .34, fw));
    float edge = 1. - 1.3 * fw, kerb = edge - 1.5 * fw;
    col *= .95 + .08 * ckFbm(vLocal.xz * 16.);
    col = mix(col, col * 1.14 + .04, ckBand(a, kerb, edge, fw * .5) * k);
    ckInk = k * max(ckBand(a, edge, 1.5, fw * .5), .35 * ckBand(a, kerb - .5 * fw, kerb + .3 * fw, fw * .4)) * .85;
  }
  return col;
}
`;


// the first appearance, vertex side: the city lies flat on the paper and rises
// a moment after the wash reaches it; trees swell from their roots
const INTRO_RISE = /* glsl */`
uniform float uIntro;
float giHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float giNoise(vec2 p) { vec2 i = floor(p), f = fract(p), u = f * f * (3. - 2. * f); return mix(mix(giHash(i), giHash(i + vec2(1, 0)), u.x), mix(giHash(i + vec2(0, 1)), giHash(i + vec2(1, 1)), u.x), u.y); }
float cityRise(vec2 xz) {
  if (uIntro > 30.) return 1.;
  float k = clamp(uIntro / 3.7, 0., 1.), front = 9.5 * (k < .5 ? 4. * k * k * k : 1. - pow(2. - 2. * k, 3.) * .5);
  float d = length(xz - vec2(1.35, -1.75)) + 1.1 * (giNoise(xz * .9 + 2.) - .5);
  float h = smoothstep(.25, 1.9, front - d);
  return mix(.35, 1., h * h * (3. - 2. * h)); // it rises from a third of its height, not from flat
}
`;
const RISE = `
  #ifdef USE_INSTANCING
  transformed *= cityRise(instanceMatrix[3].xz);
  #else
  transformed.y *= cityRise(transformed.xz);
  #endif`;
// the knot grows like a vine along its own curve, from one seed both ways,
// until the two ends meet; beyond the growing tip it waits folded into it
const KNOT_GROW = /* glsl */`
uniform float uIntro;
float kHide = 0.;
vec3 knotGrow(vec3 kl) {
  if (uIntro > 30.) return kl;
  float k = clamp((uIntro - .35) / 3.9, 0., 1.); k = k < .5 ? 4. * k * k * k : 1. - pow(2. - 2. * k, 3.) * .5;
  float rel = fract(kl.x - .62 + .5) - .5, kd = abs(rel), kf = .62 * k; // starts from nothing, like the city
  if (kd > kf) { kHide = 1.; return vec3(.62 + sign(rel) * kf, 0., 0.); } // not grown yet: gathered into the tip, with no width
  kl.yz *= smoothstep(kf, kf - .07, kd); // the growing tip tapers
  return kl;
}
`;

// Knot vertices hold (u, height, across) and a normal in the street frame; the
// shader bends them onto the moving knot. KNOT_FRAME lets begin_vertex reuse
// the frame when beginnormal_vertex has already built it.
function injectKnot(sh, motion, crown = false) {
  // an instanced crown is first turned, scaled and set down in street coordinates
  const local = crown ? `
  float kc = cos(aI1.z), ks = sin(aI1.z);
  vec3 kq = vec3(position.x * kc - position.z * ks, position.y, position.x * ks + position.z * kc) * vec3(aI1.x, aI1.y, aI1.x);
  vec3 kLocal = vec3(aI0.x + kq.x * aI1.w, aI0.w * (aI0.y + kq.y), aI0.w * (aI0.z + kq.z));
  vec3 kn0 = vec3(normal.x * kc - normal.z * ks, normal.y, normal.x * ks + normal.z * kc);
  vec3 kNorm = vec3(kn0.x, aI0.w * kn0.y, aI0.w * kn0.z);` : `
  vec3 kLocal = position, kNorm = normal;`;
  sh.uniforms.uIntro = motion.intro;
  sh.uniforms.tSpine = motion.spine;
  const grown = local + '\n  kLocal = knotGrow(kLocal);';
  sh.vertexShader = motion.glsl + KNOT_GROW + (crown ? 'attribute vec4 aI0;\nattribute vec4 aI1;\n' : '') + sh.vertexShader
    .replace('#include <beginnormal_vertex>', `${grown}
  vec3 kP, kT, kN, kB; kFrame(kLocal.x, kP, kT, kN, kB);
  #define KNOT_FRAME
  vec3 objectNormal = normalize(kT * kNorm.x + kN * kNorm.y + kB * kNorm.z);
  #ifdef USE_TANGENT
  vec3 objectTangent = vec3(tangent.xyz);
  #endif`)
    .replace('#include <begin_vertex>', `#ifndef KNOT_FRAME
  ${grown}
  vec3 kP, kT, kN, kB; kFrame(kLocal.x, kP, kT, kN, kB);
  #endif
  vec3 transformed = kP + kN * kLocal.y + kB * kLocal.z;
  vKAO = 0.45 + 0.55 * smoothstep(${f4(0.3 * motion.far)}, ${f4(motion.far)}, length(transformed));`);
}

// Every styled surface also writes fine pen detail (window frames, tile
// courses, leaf marks, cracks) into the alpha channel as 1 - ink. The wash
// softens the colour; the composite lays this ink back on crisp.
let programId = 0;
function styledMaterial(uniforms, motion = null, crown = false) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  const key = 'ck-styled-' + (motion ? 'knot' : 'flat') + (crown ? '-crown' : '') + (programId++);
  m.customProgramCacheKey = () => key;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime;
    sh.uniforms.uAlive = uniforms.uAlive;
    const shift = crown ? '\n  vWall += aI0.xz * vec2(31., 5.);' : '\n  #ifdef USE_INSTANCING\n  vWall += instanceMatrix[3].xz * 2.7;\n  #endif';
    sh.vertexShader = 'attribute float aStyle;\nattribute vec2 aWall;\nvarying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\n'
      + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vStyle = aStyle; vWall = aWall; vLocal = position;' + shift);
    if (motion) injectKnot(sh, motion, crown);
    else { sh.uniforms.uIntro = uniforms.uIntro; sh.vertexShader = INTRO_RISE + sh.vertexShader.replace('vLocal = position;', 'vLocal = position;' + RISE); }
    const shadeKnot = motion ? ' * vKAO' : '';
    sh.fragmentShader = GLSL_COMMON + (motion ? 'varying float vKAO;\n' : '') + GLSL_STYLE
      + sh.fragmentShader
        .replace('#include <color_fragment>', `#include <color_fragment>\n  diffuseColor.rgb = ckStylize(diffuseColor.rgb)${shadeKnot};`)
        .replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor.a = 1. - ckInk;');
  };
  return m;
}
function cityDepthMaterial(uniforms) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.customProgramCacheKey = () => 'ck-city-depth';
  m.onBeforeCompile = (sh) => { sh.uniforms.uIntro = uniforms.uIntro; sh.vertexShader = INTRO_RISE + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>' + RISE); };
  return m;
}
function knotDepthMaterial(uniforms, motion, crown = false) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.customProgramCacheKey = () => 'ck-knot-depth' + (crown ? '-crown' : '');
  m.onBeforeCompile = (sh) => { sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uAlive = uniforms.uAlive; injectKnot(sh, motion, crown); };
  return m;
}
// Pen lines are drawn into their own layer so the colour wash can be softened
// without softening them. There is no depth buffer there, so each line
// fragment checks the scene's depth itself.
function inkMaterial(uniforms, motion = null) {
  const m = new THREE.LineBasicMaterial({ color: 0x3b3129, transparent: true, opacity: 0.62, depthTest: false, depthWrite: false });
  m.customProgramCacheKey = () => (motion ? 'ck-knot-ink' : 'ck-ink');
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: uniforms.uTime, uAlive: uniforms.uAlive, tSceneDepth: uniforms.tSceneDepth, uInkRes: uniforms.uInkRes });
    if (motion) {
      injectKnot(sh, motion);
      sh.vertexShader = 'varying float vKHide;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vKHide = kHide;');
      sh.fragmentShader = 'varying float vKHide;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\n  if (vKHide > .01) discard;');
    }
    if (!motion && uniforms.uLand) {
      Object.assign(sh.uniforms, { uLand: uniforms.uLand, uLandA: uniforms.uLandA, uBlend: uniforms.uBlend, uIntro: uniforms.uIntro });
      sh.vertexShader = INTRO_RISE + 'varying vec3 vIsle;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vIsle = position;' + RISE);
      sh.fragmentShader = GLSL_COMMON.replace('varying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\nuniform float uTime;\n', '') + LAND_FADE + 'varying vec3 vIsle;\n'
        + sh.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor.a *= smoothstep(.2, .85, landFade(vIsle, (vIsle.xz - uLandA.xy) / uLandA.zw));');
    }
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', `uniform sampler2D tSceneDepth;
uniform vec2 uInkRes;
void main() {
  if (gl_FragCoord.z > texture2D(tSceneDepth, gl_FragCoord.xy / uInkRes).x + .0004) discard;`);
  };
  return m;
}
// Water: a drifting wash, darker under the banks, pale streaks across the
// current and a few pen ripples near the shore. vWall carries (fade to paper,
// distance from the bank); at the mouths the wash lightens and bleeds out,
// reaching pure white, which the composite treats as bare paper.
function waterMaterial(uniforms) {
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  m.customProgramCacheKey = () => 'ck-water';
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uniforms.uTime; sh.uniforms.uIntro = uniforms.uIntro;
    sh.vertexShader = INTRO_RISE + 'attribute vec2 aWall;\nvarying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\n'
      + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLocal = position; vWall = aWall;' + RISE);
    sh.fragmentShader = GLSL_COMMON + 'float ckPaper = 0., ckInk = 0.;\n' + sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec2 p = vLocal.xz;
    float open = vWall.y;
    float a = ckFbm(p * vec2(2.2, 4.4) + vec2(uTime * .045, -uTime * .03));
    diffuseColor.rgb *= (.84 + .3 * a) * mix(.86, 1., open);
    float s = ckNoise(p * vec2(2.4, 17.) + vec2(uTime * .04, 0.)) * ckNoise(p * vec2(4.3, 29.) + vec2(-uTime * .07, uTime * .02));
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.22 + .03, smoothstep(.3, .62, s) * (.35 + .65 * open));
    vec2 g = p * vec2(9., 13.);
    float fw = fwidth(g.y), cell = floor(g.y);
    float dash = step(.72, ckNoise(vec2(g.x + cell * 7.3, cell * 1.9 + uTime * .05)));
    ckInk = dash * ckBand(fract(g.y), .45, .55, fw) * (1. - smoothstep(.3, .6, fw)) * .22 * (1. - .75 * open);
    float f = clamp(vWall.x * 1.2 + .5 * (ckFbm(p * 2.1 + 3.1) - .5) + .16 * (ckNoise(p * 8.) - .5), 0., 1.);
    f = max(f, smoothstep(.75, .97, vWall.x));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.6, .7, .75), smoothstep(0., .45, f));
    diffuseColor.rgb *= 1. - .1 * ckBand(f, .33, .43, .05); // pigment dries darker at the edge of the wash
    ckPaper = smoothstep(.42, .66, f);
  }`).replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  gl_FragColor = vec4(mix(gl_FragColor.rgb, vec3(1.), ckPaper), 1. - ckInk * (1. - ckPaper));');
  };
  return m;
}

// The finishing pass: ink where one surface stands in front of another, a
// little pigment pooling at the edges of washes, cool shade, paper tooth, and a
// slow hand wobble to the lines.
const POST_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
// Ambient occlusion from the depth buffer: rebuild the surface normal from
// neighbouring depths, then ask how much of a small hemisphere above the point
// is buried. Streets, courtyards, arch soffits and the knot's inner strands
// darken the way they do in the painting. Runs at half resolution; the 4x4
// rotation pattern is removed by the 4x4 blur in the composite.
const AO_FRAG = GLSL_COMMON.replace('varying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\n', '') + /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec2 uRes;
uniform float uRadius;
uniform float uNear;
uniform float uFar;
uniform vec3 uKernel[16];
varying vec2 vUv;
vec3 vpos(vec2 uv) { float d = texture2D(tDepth, uv).x; vec4 p = uProjInv * vec4(vec3(uv, d) * 2. - 1., 1.); return p.xyz / p.w; }
float vz(vec2 uv) { float d = texture2D(tDepth, uv).x; return -uNear * uFar / (uFar - d * (uFar - uNear)); }
void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d > .99999) { gl_FragColor = vec4(1.); return; }
  vec2 px = 1. / uRes;
  vec3 P = vpos(vUv);
  vec3 Pr = vpos(vUv + vec2(px.x, 0.)), Pl = vpos(vUv - vec2(px.x, 0.));
  vec3 Pu = vpos(vUv + vec2(0., px.y)), Pd = vpos(vUv - vec2(0., px.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  vec2 ip = mod(floor(gl_FragCoord.xy), 4.);
  float a = (mod(ip.x * 5. + ip.y * 3., 16.) + .5) / 16. * 6.2831853;
  vec3 rv = vec3(cos(a), sin(a), .3);
  vec3 T = normalize(rv - N * dot(rv, N)), B = cross(N, T);
  float occ = 0.;
  for (int i = 0; i < 16; i++) {
    vec3 S = P + (T * uKernel[i].x + B * uKernel[i].y + N * uKernel[i].z) * uRadius;
    vec4 o = uProj * vec4(S, 1.);
    float sz = vz(o.xy / o.w * .5 + .5);
    float range = smoothstep(0., 1., uRadius / max(abs(P.z - sz), 1e-4));
    occ += step(S.z + .03 * uRadius, sz) * range;
  }
  gl_FragColor = vec4(vec3(1. - occ / 16.), 1.);
}
`;

// The wash: the render softened a little and let drift a few pixels off the
// drawing, with the occlusion laid in, the way colour is washed under ink.
const WASH_FRAG = GLSL_COMMON.replace('varying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\n', '') + /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform vec2 uRes;
uniform float uPx;
uniform float uNear;
uniform float uFar;
uniform float uAO;
uniform float uSoft;
uniform float uDrift;
uniform float uBehind;
varying vec2 vUv;
float linZ(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
// ---- the coast dissolving into the paper: a pixel's city position comes back
// from its depth, and the island's land field there says how near the coast it
// is. Within a ragged band the painting thins out into the ground beneath.
uniform sampler2D uLand;
uniform vec4 uLandA;
uniform mat4 uToCity;
uniform vec3 uBlend;
// how much of the painting survives at island point p (t: its place in the land texture)
uniform float uIntro;  // seconds into the first appearance; large once it is over
// how far the wash has spread from downtown by time t, and whether it has reached p
float ckEase(float k) { k = clamp(k, 0., 1.); return k < .5 ? 4. * k * k * k : 1. - pow(2. - 2. * k, 3.) * .5; } // slow start, then it gathers pace, then settles
float bloomFront(float t) { return 9.5 * ckEase(t / 3.7); }
float introBloom(vec2 xz) {
  if (uIntro > 30.) return 1.;
  float d = length(xz - vec2(1.35, -1.75)) + 1.1 * (ckFbm(xz * .9 + 2.) - .5) + .3 * (ckNoise(xz * 5.) - .5);
  return smoothstep(0., .22, bloomFront(uIntro) - d);
}
float landFade(vec3 p, vec2 t) {
  float inland = texture2D(uLand, t).r * 1.5;
  float l = inland + .5 * (ckFbm(p.xz * 1.15 + 3.1) - .5) + .14 * (ckNoise(p.xz * 7.3 + 1.) - .5);
  // a ragged edge where the wash stops, then a thinner wash just inside it
  float f = .62 * smoothstep(uBlend.y, uBlend.y + .07, l) + .38 * smoothstep(uBlend.y + .12, uBlend.z, l);
  f *= smoothstep(.03, .1, inland); // the shore rocks themselves always drop out
  f *= mix(smoothstep(.7, 1., inland), 1., smoothstep(-.1, -.045, p.y)); // cliff faces below the coast drop out
  return mix(1., f, uBlend.x) * introBloom(p.xz);
}
float coastFade(vec2 uv, float d) {
  if (d > .99999 || (uBlend.x <= 0. && uIntro > 30.)) return 1.;
  vec4 p = uToCity * vec4(vec3(uv, d) * 2. - 1., 1.);
  p.xyz /= p.w;
  vec2 t = (p.xz - uLandA.xy) / uLandA.zw;
  if (t.x < 0. || t.y < 0. || t.x > 1. || t.y > 1.) return 1.;
  return landFade(p.xyz, t);
}

void main() {
  vec2 px = 1. / uRes, q = gl_FragCoord.xy / uPx;
  vec2 uv = vUv + (vec2(ckFbm(q / 48.), ckFbm(q / 48. + 19.3)) - .5) * uDrift * uPx * px;
  float d0 = texture2D(tDepth, uv).x, z0 = linZ(d0);
  float a0 = ckNoise(q / 9.) * 6.2831853;
  vec3 acc = texture2D(tColor, uv).rgb;
  float cov = step(d0, .99999);
  for (int i = 0; i < 12; i++) {
    float fi = float(i), r = sqrt((fi + .5) / 12.) * uSoft * uPx, a = a0 + fi * 2.39996;
    vec2 o = vec2(cos(a), sin(a)) * r * px;
    acc += texture2D(tColor, uv + o).rgb;
    cov += step(texture2D(tDepth, uv + o).x, .99999);
  }
  vec3 col = acc / 13.;
  cov /= 13.;
  cov *= coastFade(uv, d0);
  float ao = 0., wsum = 0.;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i), float(j)) - 1.5) * 2. * px;
    float zt = linZ(texture2D(tDepth, uv + o).x);
    float w = 1. / (1. + 60. * abs(zt - z0) / z0);
    ao += texture2D(tAO, uv + o).r * w; wsum += w;
  }
  ao = pow(clamp(ao / wsum, 0., 1.), 1.3);
  float blank = smoothstep(.985, .998, min(min(col.r, col.g), col.b)); // water faded out to bare paper takes no shade
  col *= mix(1., ao, uAO * cov * (1. - blank));
  // a shadow wash just behind whatever stands in front: where the depth on
  // both sides of a point is nearer than the point itself (a strand passing
  // over, a street between tall walls), the wash deepens and cools
  float hid = 0.;
  for (int i = 0; i < 6; i++) {
    float fi = float(i), r = (3. + 9. * (fi + .5) / 6.) * uPx, a = a0 + fi * 1.0472;
    vec2 o = vec2(cos(a), sin(a)) * r * px;
    float za = min(linZ(texture2D(tDepth, uv + o).x), z0 * 1.02), zb = min(linZ(texture2D(tDepth, uv - o).x), z0 * 1.02);
    hid += clamp((z0 - .5 * (za + zb)) / z0 * 60., 0., 1.);
  }
  col *= 1. - uBehind * (hid / 6.) * vec3(1., .92, .72) * step(d0, .99999) * (1. - blank);
  gl_FragColor = vec4(col, cov);
}
`;

// The composite: pigment gathers at the edges of washes and granulates in the
// paper's tooth, density varies across the sheet, the paper shows through, and
// the pen lines sit crisp on top with a slight hand wobble.
const POST_FRAG = GLSL_COMMON.replace('varying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\n', '') + /* glsl */`
uniform sampler2D tWash;
uniform sampler2D tInk;
uniform sampler2D tScene;
uniform sampler2D tDepth;
uniform sampler2D tAO;
uniform vec2 uRes;
uniform float uPx;
uniform float uNear;
uniform float uFar;
uniform float uEdge;
uniform float uGran;
uniform float uLine;
uniform vec3 uPaper;
uniform vec3 uWarm;
uniform vec3 uInk;
uniform float uIsle;
uniform int uBg;
uniform int uBgVar;
varying vec2 vUv;
float linZ(float d) { return uNear * uFar / (uFar - d * (uFar - uNear)); }
float lum(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
vec3 ckLin(vec3 s) { return pow(s, vec3(2.2)); }
float ckAA(float d, float w) { return 1. - smoothstep(-w, w, d); }

// ---- backdrops: very pale grounds laid under the figures, in sRGB tints
// 1 a mosaic of slightly askew tiles whose tone follows a slow field
vec3 bdMosaic(vec2 q) {
  vec2 g = q / 10.;
  g.x += ckHash(vec2(0., floor(g.y))) * .9 + .25 * sin(g.y * .31); // each course laid a little off the last
  vec2 cell = floor(g), f = fract(g) - .5;
  float h1 = ckHash(cell), h2 = ckHash(cell + 17.3), h3 = ckHash(cell + 41.9);
  float a = (h1 - .5) * .3, cs = cos(a), sn = sin(a);
  vec2 p = mat2(cs, -sn, sn, cs) * (f - (vec2(h2, h3) - .5) * .07);
  float tile = ckAA(max(abs(p.x), abs(p.y)) - mix(.36, .43, h3), fwidth(g.x) * .8);
  vec3 c = mix(vec3(.95, .93, .885), vec3(.905, .87, .8), smoothstep(.35, .75, ckFbm(cell * .035 + 3.1)));
  c = mix(c, vec3(.875, .9, .87), smoothstep(.55, .8, ckFbm(cell * .05 + 11.)) * .8);
  c = mix(c, vec3(.86, .89, .915), smoothstep(.6, .85, ckFbm(cell * .045 + 23.)) * .7);
  c *= .965 + .07 * h1;
  return mix(vec3(.99, .985, .97), c, tile);
}
// 2 a feature map: small square cells, their value a smooth field
vec3 bdGrid(vec2 q) {
  vec2 g = q / 7., cell = floor(g), f = fract(g);
  float w = fwidth(g.x) * .8;
  float sq = ckAA(max(abs(f.x - .5), abs(f.y - .5)) - .4, w);
  float v = smoothstep(.3, .8, ckFbm(cell * .045 + 5.)) * .8 + .2 * ckHash(cell);
  vec3 c = mix(vec3(.965, .962, .95), vec3(.8, .86, .875), v * v);
  return mix(vec3(.99, .987, .978), c, sq);
}
// 3 a plain wash: blotchy pale tone with granulation
vec3 bdWash(vec2 q) {
  float n = ckFbm(q / 120.), m = ckFbm(q / 55. + 9.), gr = ckFbm(q / 1.8);
  vec3 c = mix(vec3(.94, .92, .875), vec3(.885, .905, .87), smoothstep(.35, .7, n));
  c = mix(c, vec3(.875, .9, .925), smoothstep(.55, .8, m) * .65);
  return c * (.985 + .03 * gr);
}
// 4 contour lines of a slow field, like a loss landscape, over a whisper of wash
vec3 bdContour(vec2 q) {
  vec2 u = q / 230.;
  float fld = .6 * ckNoise(u + 1.7) + .28 * ckNoise(u * 2.1 + 4.2) + .12 * ckNoise(u * 4.3 + 8.1);
  float v = fld * 30., w = fwidth(v);
  float dl = (.5 - abs(fract(v) - .5)) / max(w, 1e-4); // distance to the nearest contour, in pixels-ish
  float line = 1. - smoothstep(.5, 1.3, dl);
  float major = step(4.5, mod(floor(v + .5), 5.));
  vec3 base = mix(vec3(.978, .972, .958), vec3(.955, .958, .95), smoothstep(.3, .7, fld)) * (.992 + .016 * ckFbm(q / 1.8));
  return mix(base, vec3(.76, .74, .7), line * mix(.3, .58, major));
}
// 5 halftone dots whose size follows a slow field
vec3 bdDots(vec2 q) {
  vec2 g = q / 7.;
  g.x += .5 * mod(floor(g.y), 2.);
  vec2 cell = floor(g), f = fract(g) - .5;
  float v = smoothstep(.25, .85, ckFbm(cell * .04 + 2.3));
  float r = mix(.1, .38, v);
  float dot_ = ckAA(length(f) - r, fwidth(g.x) * .8);
  return mix(vec3(.99, .986, .976), vec3(.74, .78, .8), dot_ * .8);
}
// A smooth (B-spline) sample of one mip level: bilinear mips are only C0, and
// contour lines drawn on them would kink at every texel.
float ckCubicA(sampler2D t, vec2 uv, int lod) {
  vec2 res = vec2(textureSize(t, lod));
  vec2 st = uv * res - .5, i = floor(st), f = fract(st);
  vec2 w0 = (1. - f) * (1. - f) * (1. - f) / 6., w1 = (4. - 6. * f * f + 3. * f * f * f) / 6.;
  vec2 w2 = (1. + 3. * f + 3. * f * f - 3. * f * f * f) / 6., w3 = f * f * f / 6.;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - .5 + w1 / g0) / res, h1 = (i + 1.5 + w3 / g1) / res;
  float lf = float(lod);
  return g0.y * (g0.x * textureLod(t, vec2(h0.x, h0.y), lf).a + g1.x * textureLod(t, vec2(h1.x, h0.y), lf).a)
       + g1.y * (g0.x * textureLod(t, vec2(h0.x, h1.y), lf).a + g1.x * textureLod(t, vec2(h1.x, h1.y), lf).a);
}
// how far a point sits from the figures, as a smooth field (0 on them, rising outward)
float figureDist() {
  int L = int(log2(uPx) + .5);
  float h = .4 * ckCubicA(tWash, vUv, 5 + L) + .35 * ckCubicA(tWash, vUv, 7 + L) + .25 * ckCubicA(tWash, vUv, 8 + L);
  return sqrt(max(-log(h * .985 + .0025), 0.));
}
float slowField(vec2 q) {
  vec2 u = q / 230.;
  return .6 * ckNoise(u + 1.7) + .28 * ckNoise(u * 2.1 + 4.2) + .12 * ckNoise(u * 4.3 + 8.1);
}
// a contour line drawn by hand: weight wanders along it, it breaks now and then
float handLine(float v, vec2 q, float weight, float breaks) {
  float w = fwidth(v), dl = (.5 - abs(fract(v) - .5)) / max(w, 1e-4);
  float wt = weight * (.75 + .5 * ckNoise(q / 23. + v * 3.1));
  float line = 1. - smoothstep(.35 * wt, .35 * wt + .9, dl);
  float gap = smoothstep(breaks - .06, breaks + .06, ckNoise(q / 31. + floor(v + .5) * 7.3));
  return line * (1. - gap);
}
vec3 bdContourFamily(vec2 q) {
  vec3 paper = vec3(.978, .972, .958) * (.992 + .016 * ckFbm(q / 1.8));
  vec3 ink = vec3(.72, .7, .66), cool = vec3(.62, .68, .72);
  vec2 wq = q + 14. * (vec2(ckNoise(q / 90.), ckNoise(q / 90. + 5.3)) - .5); // a slight hand wobble
  if (uBgVar == 1) { // refined hand-drawn contours of a slow landscape
    float v = slowField(wq) * 30.;
    float major = step(4.5, mod(floor(v + .5), 5.));
    float l = handLine(v, q, mix(1., 1.8, major), .8);
    return mix(paper, ink, l * mix(.3, .5, major));
  }
  if (uBgVar == 2 || uBgVar == 6) { // rings around the two figures, meeting in a saddle between them
    float d = figureDist() + .025 * (slowField(wq) - .5);
    float v = d * 11.;
    float major = step(4.5, mod(floor(v + .2), 5.));
    float l = handLine(v, q, mix(1.1, 1.8, major), .9) * smoothstep(.04, .16, d);
    vec3 ground = paper;
    if (uBgVar == 6) { // over a very pale terraced wash
      float band = floor(v / 2.), fb = fract(v / 2.);
      vec3 tint = mix(vec3(.975, .968, .95), vec3(.958, .965, .962), ckHash(vec2(band, 3.)));
      ground = mix(ground, tint * (1. - .03 * smoothstep(.75, 1., fb)) * (.99 + .02 * ckFbm(q / 1.6)), smoothstep(2.4, .4, d));
    }
    return mix(ground, mix(ink, cool, .35), l * mix(.36, .56, major));
  }
  if (uBgVar == 3) { // basins: the figures sit in hollows of a wider landscape
    float d = figureDist();
    float v = (.55 * d + .45 * slowField(wq) * 3.2) * 10.;
    float major = step(4.5, mod(floor(v + .5), 5.));
    float l = handLine(v, q, mix(1., 1.7, major), .84) * smoothstep(.1, .3, d);
    return mix(paper, ink, l * mix(.3, .5, major));
  }
  if (uBgVar == 4) { // painted terraces: pale stepped washes with pooled edges, no lines
    float d = figureDist();
    float v = (.55 * d + .45 * slowField(wq) * 3.2) * 6.;
    float band = floor(v), f = fract(v);
    vec3 tint = mix(vec3(.972, .965, .945), vec3(.955, .962, .95), ckHash(vec2(band, 3.)));
    tint = mix(tint, vec3(.952, .96, .968), smoothstep(.5, 1., ckHash(vec2(band, 9.))) * .6);
    float pool = smoothstep(.8, 1., f) * .035;
    return mix(paper, tint * (1. - pool) * (.985 + .03 * ckFbm(q / 1.6)), smoothstep(.1, .3, d));
  }
  // 5 survey map: solid index lines, fine dashed lines between
  float d = figureDist();
  float v = (.55 * d + .45 * slowField(wq) * 3.2) * 12.;
  float major = step(4.5, mod(floor(v + .5), 5.));
  float w = fwidth(v), dl = (.5 - abs(fract(v) - .5)) / max(w, 1e-4);
  float line = 1. - smoothstep(mix(.25, .7, major), mix(.25, .7, major) + .9, dl);
  float dash = mix(step(.45, fract((q.x * .7 + q.y * .7) / 7. + ckNoise(q / 40.) * 3.)), 1., major);
  return mix(paper, mix(cool, ink, major), line * dash * mix(.32, .5, major) * smoothstep(.1, .3, d));
}
vec3 backdrop(vec2 q) {
  if (uBg == 1) return bdMosaic(q);
  if (uBg == 2) return bdGrid(q);
  if (uBg == 3) return bdWash(q);
  if (uBg == 4) return uBgVar > 0 ? bdContourFamily(q) : bdContour(q);
  return bdDots(q);
}

// ---- the coast dissolving into the paper: a pixel's city position comes back
// from its depth, and the island's land field there says how near the coast it
// is. Within a ragged band the painting thins out into the ground beneath.
uniform sampler2D uLand;
uniform vec4 uLandA;
uniform mat4 uToCity;
uniform vec3 uBlend;
// how much of the painting survives at island point p (t: its place in the land texture)
uniform float uIntro;  // seconds into the first appearance; large once it is over
// how far the wash has spread from downtown by time t, and whether it has reached p
float ckEase(float k) { k = clamp(k, 0., 1.); return k < .5 ? 4. * k * k * k : 1. - pow(2. - 2. * k, 3.) * .5; } // slow start, then it gathers pace, then settles
float bloomFront(float t) { return 9.5 * ckEase(t / 3.7); }
float introBloom(vec2 xz) {
  if (uIntro > 30.) return 1.;
  float d = length(xz - vec2(1.35, -1.75)) + 1.1 * (ckFbm(xz * .9 + 2.) - .5) + .3 * (ckNoise(xz * 5.) - .5);
  return smoothstep(0., .22, bloomFront(uIntro) - d);
}
float landFade(vec3 p, vec2 t) {
  float inland = texture2D(uLand, t).r * 1.5;
  float l = inland + .5 * (ckFbm(p.xz * 1.15 + 3.1) - .5) + .14 * (ckNoise(p.xz * 7.3 + 1.) - .5);
  // a ragged edge where the wash stops, then a thinner wash just inside it
  float f = .62 * smoothstep(uBlend.y, uBlend.y + .07, l) + .38 * smoothstep(uBlend.y + .12, uBlend.z, l);
  f *= smoothstep(.03, .1, inland); // the shore rocks themselves always drop out
  f *= mix(smoothstep(.7, 1., inland), 1., smoothstep(-.1, -.045, p.y)); // cliff faces below the coast drop out
  return mix(1., f, uBlend.x) * introBloom(p.xz);
}
float coastFade(vec2 uv, float d) {
  if (d > .99999 || (uBlend.x <= 0. && uIntro > 30.)) return 1.;
  vec4 p = uToCity * vec4(vec3(uv, d) * 2. - 1., 1.);
  p.xyz /= p.w;
  vec2 t = (p.xz - uLandA.xy) / uLandA.zw;
  if (t.x < 0. || t.y < 0. || t.x > 1. || t.y > 1.) return 1.;
  return landFade(p.xyz, t);
}

// the contour against the paper: a heavier line, swelling and thinning with the hand
float outline(vec2 uv, vec2 px) {
  float o = 0.;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * .785398 + .39;
    vec2 d = vec2(cos(a), sin(a)) * uPx * px;
    o += step(.99999, texture2D(tDepth, uv + d * 1.3).x) + step(.99999, texture2D(tDepth, uv + d * 2.1).x) * .6;
  }
  float press = .55 + .55 * ckNoise(gl_FragCoord.xy / uPx / 34.);
  return smoothstep(.3, 2.2, o) * .74 * press;
}
// hatching in deep shade: broken diagonal strokes, a little uneven in spacing
float hatch(vec2 q, float shade) {
  float s = 3.4, h = (q.x - q.y) * .7071 + 1.2 * ckNoise(q / 31.), along = (q.x + q.y) * .7071;
  float line = 1. - smoothstep(.3, .75, abs(fract(h / s) - .5) * s);
  float stroke = smoothstep(.3, .5, ckNoise(vec2(along / 9., floor(h / s) * 1.73)));
  return line * stroke * smoothstep(.15, .6, shade);
}
// below the island a little of the wash runs out onto the paper: the colour a
// few pixels above, thinned, fading with distance
vec4 bleed(vec2 q, vec2 px) {
  vec3 s = vec3(0.);
  float w = 0., n = 0., sc = min(1., uRes.y / uPx / 684.); // it runs as far as the drawing is large, so on a small sheet it stops short of the edge
  for (int i = 1; i <= 5; i++) {
    float fi = float(i), k = 1. - fi / 6.;
    vec4 t = texture2D(tWash, vUv + vec2((ckNoise(q / 9. + fi * 3.1) - .5) * 5., fi * 3.) * uPx * sc * px);
    t.a *= 1. - smoothstep(.985, .998, min(min(t.r, t.g), t.b)); // faded water is paper, not paint
    s += t.rgb * t.a * k; w += t.a * k; n += k;
  }
  return vec4(s / max(w, 1e-4), w / n);
}
void main() {
  vec2 px = 1. / uRes, q = gl_FragCoord.xy / uPx;
  vec4 w = texture2D(tWash, vUv);
  vec3 c = w.rgb;
  float cov = w.a;
  float blank = smoothstep(.985, .998, min(min(c.r, c.g), c.b)); // a wash faded to white is bare paper
  cov *= 1. - blank;
  vec3 b = vec3(0.);
  float bc = 0.;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * .785398 + .3;
    vec4 t = texture2D(tWash, vUv + vec2(cos(a), sin(a)) * 3.5 * uPx * px);
    b += t.rgb; bc += t.a;
  }
  b /= 8.; bc /= 8.;
  float edge = clamp(length(c - b) * 2.2, 0., 1.) + clamp((cov - bc) * 2., 0., 1.) * .8;
  float l = lum(c);
  float turb = ckFbm(q / 70.) - .5;
  float gran = ckFbm(q / 1.6) * .6 + ckNoise(q / 6.) * .4 - .5;
  float settle = 1. + 1.4 * clamp((c.b - c.r) * 3., 0., 1.); // blue pigment granulates most
  float dens = 1. + .4 * turb + uGran * gran * (1.2 - l) * settle + uEdge * edge;
  c = c - (c - c * c) * (dens - 1.);
  c = mix(vec3(lum(c)), c, 1.2);
  c = uWarm - (uWarm - c) * .95; // transparent washes: the paper lifts everything a little
  c = mix(c * vec3(.92, .96, 1.05), c * vec3(1.02, 1., .97), smoothstep(.08, .55, l));
  c = mix(c, uWarm, smoothstep(.32, .7, l) * .45); // the lightest lights are left as paper
  vec3 ground = uPaper;
  if (uBg > 0) {
    // a soft bed under the figures: wide blurs of the paint coverage (mip levels of the wash),
    // feathered with noise, reaching exactly zero at the canvas border
    float L = log2(uPx);
    float halo = max(textureLod(tWash, vUv, 5. + L).a * 1.6, textureLod(tWash, vUv, 6.8 + L).a * 2.4);
    vec2 d = (vUv - vec2(.5, .5)) * 2.;
    float oval = 1. - smoothstep(.62, 1.02, length(d * vec2(.98, 1.08)) + .12 * (ckFbm(q / 140.) - .5));
    float m = max(smoothstep(.05, .5, halo + .16 * (ckFbm(q / 60.) - .5)), oval * .85 * (uIntro > 30. ? 1. : smoothstep(2., 4.8, uIntro)));
    float edge = min(min(vUv.x, 1. - vUv.x) * 2., min(vUv.y, 1. - vUv.y)) + .05 * (ckFbm(q / 50. + 3.) - .5);
    m *= smoothstep(.0, .22, edge);
    // the knot sits low on the sheet, so below it the ground thins out over a long, uneven band instead of stopping in a line
    m *= smoothstep(.0, .42, vUv.y + .08 * (ckFbm(q / 90. + 11.) - .5));
    ground = mix(uPaper, ckLin(backdrop(q)), m);
  }
  c = mix(mix(ground, uWarm, cov), c, cov * .95);
  if (cov < .99 && vUv.x < uIsle) {
    vec4 bl = bleed(q, px);
    float reach = .2 + .55 * ckFbm(q / 11.), wet = smoothstep(reach, reach + .1, bl.a);
    float tide = wet * (1. - smoothstep(reach + .05, reach + .22, bl.a)); // it dries with a faint rim
    float run = (wet * .13 + tide * .1) * (1. - cov) * smoothstep(uIsle, uIsle - .03, vUv.x);
    c = mix(c, mix(bl.rgb, uWarm, .25), run);
  }
  vec2 hand = (vec2(ckNoise(q / 17.), ckNoise(q / 17. + 7.1)) - .5) * .8 * uPx * px;
  vec2 uv = vUv + hand;
  float d0 = texture2D(tDepth, uv).x, z0 = linZ(d0), e = 0.;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * .785398;
    float z = linZ(texture2D(tDepth, uv + vec2(cos(a), sin(a)) * 1.1 * uPx * px).x);
    e = max(e, (z - z0) / z0);
  }
  float cf = coastFade(uv, d0), cfk = smoothstep(.2, .85, cf);
  float fg = step(d0, .99999) * (1. - blank) * cfk; // water faded to paper, and the dissolving coast, take no line
  float sil = smoothstep(.012, .045, e) * mix(.42, .6, smoothstep(.06, .3, e)) * fg; // small steps get a finer line
  sil = max(sil, outline(uv, px) * fg);
  float dry = mix(.6, 1., smoothstep(.15, .45, ckNoise(q / 6. + 3.)));
  vec2 ox = vec2(.6 * uPx * px.x, 0.), oy = vec2(0., .6 * uPx * px.y);
  float pen = max(texture2D(tInk, uv).a, .75 * max(max(texture2D(tInk, uv + ox).a, texture2D(tInk, uv - ox).a), max(texture2D(tInk, uv + oy).a, texture2D(tInk, uv - oy).a)));
  float detail = 1. - texture2D(tScene, uv).a;
  vec2 ha = 3. * px;
  float occ = .25 * (texture2D(tAO, uv + ha).r + texture2D(tAO, uv - ha).r + texture2D(tAO, uv + vec2(ha.x, -ha.y)).r + texture2D(tAO, uv - vec2(ha.x, -ha.y)).r);
  float leafy = smoothstep(.01, .04, w.g - max(w.r, w.b)); // foliage has its own leaf marks
  float shade = max((.86 - occ) * 3. * (1. - smoothstep(.1, .35, l)), smoothstep(.14, .06, l)) * (1. - leafy) * fg;
  float ink = max(max(max(pen * .8, sil), detail * .85), hatch(q, shade) * .32) * dry * uLine * cfk;
  c = mix(c, uInk, ink);
  c *= 1. - .05 * smoothstep(.12, .4, cf) * (1. - smoothstep(.4, .75, cf)) * cov; // pigment gathered where the wash ran out
  c *= 1. - cov * (.035 - .05 * (ckFbm(q / 2.2) * .6 + ckNoise(q / 9.) * .4)); // tooth only where there is paint
  gl_FragColor = vec4(c, 1.);
  #include <colorspace_fragment>
}
`;

// ------------------------------------------------------------ movers

function makeTrain(nCars, len, wid, hgt, mat, ink) {
  const geo = new THREE.BoxGeometry(len, hgt, wid), eg = new THREE.EdgesGeometry(geo);
  const cars = [];
  for (let i = 0; i < nCars; i++) {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
    m.add(new THREE.LineSegments(eg, ink));
    cars.push(m);
  }
  return { cars, len, gap: len * 0.14 };
}
const _T = new THREE.Vector3(), _N = new THREE.Vector3(), _B = new THREE.Vector3();
function setCar(car, P, T, N, B) {
  car.matrix.makeBasis(_T.set(...T), _N.set(...N), _B.set(...B)).setPosition(P[0], P[1], P[2]);
  car.matrixWorldNeedsUpdate = true;
}
// Along a baked strip (the city viaduct).
function placeTrain(train, W, s, y, a) {
  const n = train.cars.length;
  train.cars.forEach((car, i) => {
    const si = s + (i - (n - 1) / 2) * (train.len + train.gap);
    setCar(car, W.p(si, y, a), W.n(si, y, a, 1, 0, 0), W.n(si, y, a, 0, 1, 0), W.n(si, y, a, 0, 0, 1));
  });
}
// Along the moving knot; flip puts the train on the far face of the strand.
function placeKnotTrain(train, knot, motion, s, y, a, flip, t, alive) {
  const n = train.cars.length;
  train.cars.forEach((car, i) => {
    const si = s + (i - (n - 1) / 2) * (train.len + train.gap);
    const u = knot.F.u(si), f = motion.frame(u, t, alive);
    const N = flip ? scl(f.N, -1) : f.N, B = flip ? scl(f.B, -1) : f.B;
    const P = add(add(f.P, scl(N, knot.Hb / 2 + y)), scl(B, a * knot.wide(u)));
    setCar(car, P, f.T, N, B);
  });
}

function makeBoat(ink) {
  const grp = new THREE.Group();
  const hullMat = new THREE.MeshLambertMaterial({ color: new THREE.Color('#f3efe6') });
  const cabMat = new THREE.MeshLambertMaterial({ color: new THREE.Color('#c27a5f') });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.035, 0.06), hullMat);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.035, 0.04), cabMat);
  cab.position.set(-0.02, 0.034, 0);
  for (const m of [hull, cab]) { m.castShadow = true; m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), ink)); grp.add(m); }
  return grp;
}

// ------------------------------------------------------------ instanced trees

const _M = new THREE.Matrix4(), _Q = new THREE.Quaternion(), _S = new THREE.Vector3(), _P = new THREE.Vector3(), _C = new THREE.Color(), _Y = new THREE.Vector3(0, 1, 0);
function cityCrowns(crowns, geos, mat) {
  return geos.map((geo, v) => {
    const list = crowns.filter((c) => c.v === v), m = new THREE.InstancedMesh(geo, mat, list.length);
    list.forEach((c, i) => {
      m.setMatrixAt(i, _M.compose(_P.set(c.x, c.y, c.z), _Q.setFromAxisAngle(_Y, -c.rot), _S.set(c.r, c.r * c.sy, c.r)));
      m.setColorAt(i, _C.setRGB(c.c[0], c.c[1], c.c[2]));
    });
    m.castShadow = true; m.receiveShadow = true;
    return m;
  });
}
function knotCrowns(cr, geos, mat, depthMat) {
  return geos.map((template, v) => {
    const idx = []; for (let i = 0; i < cr.IV.length; i++) if (cr.IV[i] === v) idx.push(i);
    const geo = template.clone(), I0 = new Float32Array(idx.length * 4), I1 = new Float32Array(idx.length * 4);
    idx.forEach((k, i) => { I0.set(cr.I0.subarray(k * 4, k * 4 + 4), i * 4); I1.set(cr.I1.subarray(k * 4, k * 4 + 4), i * 4); });
    geo.setAttribute('aI0', new THREE.InstancedBufferAttribute(I0, 4));
    geo.setAttribute('aI1', new THREE.InstancedBufferAttribute(I1, 4));
    const m = new THREE.InstancedMesh(geo, mat, idx.length);
    idx.forEach((k, i) => m.setColorAt(i, _C.setRGB(cr.IC[k * 3], cr.IC[k * 3 + 1], cr.IC[k * 3 + 2])));
    m.customDepthMaterial = depthMat;
    m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
    return m;
  });
}

// ------------------------------------------------------------ clouds
// A few small clouds, painted on after the finish. Each is a heap of round
// lobes in its own flat frame, drawn twice over a small screen quad: once as
// white paper laid over the drawing, once as a pale blue-grey glaze that pools
// on the side away from the sun and along the base. A cloud hangs at a point
// in the world, drifts downwind and thins in and out over its life; traced back
// along the sun, the same cloud lays a faint cool shadow on what is below it.
// Entries: anchor [x, y, z], half-width, lobes, how flat, seed, life (s),
// phase (s), drift over a life, and whether it is seen (some only cast shadows).
// The seen ones are placed so that, over their whole drift, they stay clear of
// the island and of the moving knot's outline.
const CLOUDS = [
  { at: [0.95, 3.2, -1.95], r: 1.15, lobes: 6, flat: 0.72, seed: 3, life: 190, phase: 45, drift: 1.4, body: true },
  { at: [-7.96, 2.5, -3.7], r: 0.9, lobes: 5, flat: 0.8, seed: 8, life: 170, phase: 100, drift: 1.3, body: true },
  { at: [8.4, -3.0, 2.3], r: 0.62, lobes: 4, flat: 1, seed: 13, life: 160, phase: 62, drift: 0.9, body: true },
  { at: [2.6, -3.05, 2.0], r: 1.25, lobes: 5, flat: 0.55, seed: 5, life: 240, phase: 118, drift: 1.5, body: true },
  { at: [-10.3, 6, 4.4], r: 1.9, lobes: 6, flat: 1, seed: 21, life: 230, phase: 80, drift: 2.2, body: false },
];
const WIND = norm([1, 0, -0.25]);

const CLOUD_VERT = /* glsl */`
uniform vec4 uRect;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(mix(uRect.xy, uRect.zw, uv) * 2. - 1., 0., 1.); }
`;
// The cloud's field, > 0 inside, and how much sun it catches there: each lobe
// is a ball lit from the upper left, laid over the ones before it (the lobes
// come highest first, so lower puffs sit in front). crease is the rim of a
// lobe where it overlaps one behind.
const CLOUD_FIELD = /* glsl */`
uniform vec4 uLobe[8];
float ckCloud(vec2 q, out float lit, out float crease) {
  float d = -9.;
  lit = 1.; crease = 0.;
  for (int i = 0; i < 8; i++) {
    vec4 l = uLobe[i];
    vec2 n = (q - l.xy) / l.z;
    float di = 1. - length(n), cov = smoothstep(0., .07, di);
    n /= max(1., length(n));
    lit = mix(lit, dot(vec3(n, sqrt(max(0., 1. - dot(n, n)))), vec3(-.45, .72, .53)), cov);
    crease = max(crease * (1. - cov), cov * (1. - smoothstep(.07, .2, di)) * smoothstep(0., .08, d));
    d = max(d, di);
  }
  return d;
}
`;
const CLOUD_FRAG = GLSL_COMMON.replace('varying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\n', '') + CLOUD_FIELD + /* glsl */`
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uPx;
uniform vec3 uC;
uniform float uR;
uniform float uFlat;
uniform float uLife;
uniform float uSeed;
varying vec2 vUv;
uniform float uStrength;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  if (texture2D(tDepth, uv).x < uC.z) discard; // a strand in front hides it
  vec2 q = (gl_FragCoord.xy - uC.xy) / uR / vec2(1., uFlat);
  vec2 w = vec2(ckFbm(q * 2.1 + uSeed + uTime * .011), ckFbm(q * 2.1 + uSeed + 7.7 - uTime * .009)) - .5;
  vec2 w2 = vec2(ckNoise(q * 6.5 + uSeed + 2.), ckNoise(q * 6.5 + uSeed + 11.)) - .5;
  float lit, crease, d = ckCloud(q + w * .24 + w2 * .07, lit, crease) - (1. - uLife) * (.12 + .5 * ckFbm(q * 2.6 + uSeed + 13.)); // it forms and thins raggedly
  d += ((ckNoise(q * 7.5 + uSeed) - .5) * .1 + (ckNoise(q * 13. + uSeed) - .5) * .04) * smoothstep(-.2, .3, q.y); // small bumps, most on top
  float wisp = 1. - smoothstep(.4, .7, uFlat); // a flat cloud is a wisp: streaky, softer, thinner, no pen
  d += wisp * (ckFbm(vec2(q.x * 1.6, q.y * 7.) + uSeed + uTime * .01) - .5) * .5;
  float base = smoothstep(-.43, -.3 + .1 * wisp, q.y + w.y * .08);
  float edge = smoothstep(0., .07, min(min(uv.x, 1. - uv.x), min(uv.y, 1. - uv.y))) * smoothstep(0., .6, uLife) * (1. - .25 * wisp); // never near the sheet's border
  float body = smoothstep(0., .14 + .3 * wisp, d) * base * edge;
  float wash = smoothstep(0., .05 + .25 * wisp, d) * base * edge;
  if (max(body, wash) < .002) discard;
  // Two glazes: one over the lobes' far sides and the lower heap, drying soft
  // in places and with a hard, pigment-lined edge in others, and a second
  // along the base.
  float lw = mix(lit, smoothstep(-.3, .45, q.y) - .1, .4) + (ckNoise(q * 5. + uSeed + 3.) - .5) * .3, hard = smoothstep(.5, .78, ckNoise(q * 2.2 + uSeed + 1.)) * (1. - wisp);
  float g1 = 1. - mix(smoothstep(.1, .55, lw), smoothstep(.3, .38, lw), hard);
  g1 = .04 + .3 * g1 + .12 * crease * g1 + .16 * hard * smoothstep(.31, .34, lw) * (1. - smoothstep(.34, .4, lw));
  float g2 = .28 * (1. - smoothstep(-.3, -.1, q.y + w.x * .1)) + .1 * (1. - smoothstep(.02, .14, d)) * (1.3 - smoothstep(-.34, .1, q.y)); // with pigment gathered at the wash's edge
  vec2 pq = gl_FragCoord.xy / uPx;
  float lay = (.75 + .5 * ckFbm(q * 3.5 + uSeed + 5.)) * (.7 + .6 * (ckFbm(pq / 2.) * .5 + ckNoise(pq / 6.) * .5)); // the wash lies unevenly and settles in the tooth
  g1 *= lay; g2 *= lay;
  // a faint, broken pen line round the sunny top
  float fw = fwidth(d);
  float pen = (1. - smoothstep(fw * .6, fw * 1.6, abs(d - .015))) * smoothstep(-.15, .25, q.y) * smoothstep(.35, .65, ckNoise(q * 3.3 + uSeed + 9.)) * base * edge * (1. - wisp);
  #ifdef CK_WASH
  float k = uStrength;
  gl_FragColor = vec4((1. - k * wash * g1 * vec3(.38, .3, .2)) * (1. - k * wash * g2 * vec3(.34, .32, .26)) * (1. - k * pen * .15 * vec3(.77, .81, .84)), 1.);
  #else
  gl_FragColor = vec4(1., 1., 1., body * mix(.7, .9, uStrength));
  #endif
}
`;
// the shadow: rebuild the point from depth, follow the sun up to the cloud and
// read how thick the cloud is there
const SHADOW_FRAG = GLSL_COMMON.replace('varying float vStyle;\nvarying vec2 vWall;\nvarying vec3 vLocal;\n', '') + /* glsl */`
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec3 uSun;
uniform vec4 uFoot;
uniform float uLife;
uniform float uSeed;
uniform float uDark;
varying vec2 vUv;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float dz = texture2D(tDepth, uv).x;
  if (dz > .99999) discard;
  vec4 v = uProjInv * vec4(vec3(uv, dz) * 2. - 1., 1.);
  vec3 P = (uViewInv * vec4(v.xyz / v.w, 1.)).xyz;
  vec2 f = (P.xz + uSun.xz * (uFoot.y - P.y) / uSun.y - uFoot.xz) / uFoot.w;
  float e = length(f * vec2(1., 1.6)) + (ckFbm(f * 1.5 + uSeed + uTime * .008) - .5) * .6;
  float s = (1. - smoothstep(.5, 1., e + (1. - uLife) * .8)) * (1. - smoothstep(uFoot.y - .4, uFoot.y, P.y)); // only what is below it
  gl_FragColor = vec4(1. - s * uDark * vec3(1., .86, .66), 1.);
}
`;

// Lobes in rows, wide at the base and heaped a little off centre, like a small
// cumulus, with a low foot trailing downwind; the base is cut flat at y = -0.34.
function cloudLobes(seed, n) {
  const r = mulberry32(seed * 7919), L = [], lean = (r() - 0.5) * 0.36;
  const rows = [[-0.58, -0.04, 0.5], [-0.28 + lean, 0.24 + lean], [lean * 1.4]];
  for (const [k, row] of rows.entries()) for (const x0 of row) {
    if (L.length >= n) break;
    const rad = [0.36, 0.33, 0.29][k] * (0.8 + 0.4 * r()), x = x0 * (0.9 + 0.2 * r()) + (r() - 0.5) * 0.12;
    L.push(new THREE.Vector4(x, -0.34 + [0.6, 1.25, 1.8][k] * rad * (0.9 + 0.2 * r()), rad, 0));
  }
  const x1 = Math.max(...L.map((l) => l.x + l.z * 0.6));
  for (const [dx, rad] of [[0.12, 0.2], [0.34, 0.14]]) L.push(new THREE.Vector4(x1 + dx * (0.8 + 0.4 * r()), -0.34 + 0.55 * rad, rad, 0));
  while (L.length < 8) L.push(new THREE.Vector4(0, -9, 1e-3, 0));
  return L.sort((a, b) => b.y - a.y);
}

function makeClouds(uniforms, rt, camera, res, pxr, sun, strength = 0.55) {
  const SUN = norm(sub(sun.position.toArray(), sun.target.position.toArray()));
  const scene = new THREE.Scene(), plane = new THREE.PlaneGeometry(1, 1);
  const quad = (m) => { const q = new THREE.Mesh(plane, m); q.frustumCulled = false; q.renderOrder = scene.children.length; scene.add(q); };
  const multiply = { transparent: true, blending: THREE.CustomBlending, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor, blendEquation: THREE.AddEquation };
  const onScreen = { vertexShader: CLOUD_VERT, depthTest: false, depthWrite: false };
  const common = (c) => ({ tDepth: { value: rt.depthTexture }, uRes: { value: res }, uTime: uniforms.uTime, uLife: { value: 1 }, uSeed: { value: c.seed * 3.7 }, uRect: { value: new THREE.Vector4() } });
  // shadows go down first, then each cloud's paper and its glaze
  const shadows = CLOUDS.map((c) => {
    const u = { ...common(c), uProjInv: { value: camera.projectionMatrixInverse }, uViewInv: { value: camera.matrixWorld }, uSun: { value: new THREE.Vector3(...SUN) }, uFoot: { value: new THREE.Vector4() }, uDark: { value: 0.2 * strength } };
    quad(new THREE.ShaderMaterial({ ...onScreen, ...multiply, fragmentShader: SHADOW_FRAG, uniforms: u }));
    return u;
  });
  const bodies = CLOUDS.map((c) => {
    if (!c.body) return null;
    const L = cloudLobes(c.seed, c.lobes);
    const u = { ...common(c), uPx: pxr, uC: { value: new THREE.Vector3() }, uR: { value: 1 }, uFlat: { value: c.flat }, uLobe: { value: L }, uStrength: { value: strength } };
    quad(new THREE.ShaderMaterial({ ...onScreen, transparent: true, fragmentShader: CLOUD_FRAG, uniforms: u }));
    quad(new THREE.ShaderMaterial({ ...onScreen, ...multiply, fragmentShader: CLOUD_FRAG, uniforms: u, defines: { CK_WASH: 1 } }));
    // the quad's extent in cloud units, with room for the ragged edge
    const box = [Math.min(...L.map((l) => l.x - l.z)) - 0.4, -0.5, Math.max(...L.map((l) => l.x + l.z)) + 0.4, Math.max(...L.map((l) => l.y + l.z)) + 0.35];
    return { u, box };
  });

  const V = new THREE.Vector3(), right = new THREE.Vector3();
  const toPx = (p) => { V.set(p[0], p[1], p[2]).project(camera); return [(V.x * 0.5 + 0.5) * res.x, (V.y * 0.5 + 0.5) * res.y, V.z * 0.5 + 0.5]; };
  const rect = (u, x0, y0, x1, y1) => u.set(clamp(x0 / res.x, 0, 1), clamp(y0 / res.y, 0, 1), clamp(x1 / res.x, 0, 1), clamp(y1 / res.y, 0, 1));
  return {
    scene,
    update(t, form = 1) { // form < 1 while the clouds are still condensing, at the first appearance
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      CLOUDS.forEach((c, i) => {
        const ph = (((t + c.phase) / c.life) % 1 + 1) % 1, life = smooth(0, 0.16, ph) * smooth(1, 0.84, ph) * form;
        const C = add(c.at, scl(WIND, (ph - 0.5) * c.drift)), su = shadows[i], bu = bodies[i];
        su.uLife.value = life;
        su.uFoot.value.set(C[0], C[1], C[2], c.r);
        // the footprint, traced down the sun to the heights where there is anything to shade
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const h of [-1.6, Math.min(1.2, C[1]), Math.min(4, C[1])]) for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const k = (C[1] - h) / SUN[1];
          const [sx, sy] = toPx([C[0] + dx * c.r * 1.4 - SUN[0] * k, h, C[2] + dz * c.r * 0.9 - SUN[2] * k]);
          x0 = Math.min(x0, sx); y0 = Math.min(y0, sy); x1 = Math.max(x1, sx); y1 = Math.max(y1, sy);
        }
        rect(su.uRect.value, x0, y0, x1, y1);
        if (!bu) return;
        const [cx, cy, cz] = toPx(C), [ex, ey] = toPx(add(C, scl([right.x, right.y, right.z], c.r))), R = Math.hypot(ex - cx, ey - cy), b = bu.box;
        bu.u.uLife.value = life;
        bu.u.uC.value.set(cx, cy, cz);
        bu.u.uR.value = R;
        rect(bu.u.uRect.value, cx + b[0] * R, cy + b[1] * c.flat * R, cx + b[2] * R, cy + b[3] * c.flat * R);
      });
    },
  };
}

// ------------------------------------------------------------ pause control

// The pause/play button is the essay's shared one (window.FigurePause, dist/figure-pause.js), in the
// figure's top-right corner. Its choice lasts for this page view only. The intro can be replayed from a
// small icon that appears while the pointer is over the figure.
const INTRO_KEY = 'city-and-knot-intro-seen', INTRO_LEN = 5.8;
const SPEED = 0.8; // the whole scene runs a little slower than real time
const easeInOut = (x) => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - (2 - 2 * x) ** 3 / 2; }; // slow start, then it gathers pace, then settles
const PAUSE_CSS = `
.ck-host { position: relative; }
.ck-host > .fig-pause { top: 8px; right: 10px; }
.ck-replay { position: absolute; right: 10px; bottom: 10px; width: 26px; height: 26px; padding: 0; margin: 0;
  display: grid; place-items: center; border: 1px solid rgba(59, 49, 41, .2); border-radius: 50%;
  background: rgba(255, 255, 255, .75); color: #3b3129; cursor: pointer; opacity: 0; transition: opacity .3s ease; }
.ck-host:hover .ck-replay { opacity: .4; }
.ck-host .ck-replay:hover, .ck-replay:focus-visible { opacity: .85; outline: none; box-shadow: 0 0 0 2px rgba(59, 49, 41, .18); }
.ck-replay svg { width: 10px; height: 10px; display: block; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; }
@media (hover: none) { .ck-replay { opacity: .3; } }
`;
const ICON_REPLAY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M8.3 5.4A3.3 3.3 0 1 1 7 2.2"/><path d="M5.8 1.1 7.2 2.3 6 3.6" style="stroke-linejoin:round"/></svg>';

function pauseControl(container, onPause, onPlay, onReplay) {
  if (!document.getElementById('ck-pause-style')) {
    const st = document.createElement('style');
    st.id = 'ck-pause-style'; st.textContent = PAUSE_CSS;
    document.head.appendChild(st);
  }
  container.classList.add('ck-host');
  const rb = document.createElement('button');
  rb.type = 'button'; rb.className = 'ck-replay'; rb.innerHTML = ICON_REPLAY;
  rb.setAttribute('aria-label', 'Replay the intro'); rb.title = 'Replay the intro';
  rb.addEventListener('click', onReplay);
  container.appendChild(rb);
  const FP = window.FigurePause;
  return FP ? FP.attach(container, { name: 'city and knot', still: true, pause: onPause, play: onPlay }) : null;
}

// ------------------------------------------------------------ mount

export function mountCityAndKnot(container, opts = {}) {
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fixedTime = opts.time ?? null;
  const knotSpec = { p: 3, q: 4, R: 2.4, r: 1.2, zs: 1.3, width: 1.2, height: 0.8, ...(opts.knot || {}) };
  const paper = new THREE.Color(opts.background || '#ffffff');

  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, preserveDrawingBuffer: !!opts.preserve });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxPixelRatio || 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(paper, 1);
  const canvas = renderer.domElement;
  canvas.style.cssText = 'display:block;width:100%;height:100%;opacity:0;transition:opacity 1.2s ease';
  container.appendChild(canvas);

  // the scene renders to a multisampled target whose depth also serves the ink
  const rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4, colorSpace: THREE.SRGBColorSpace, depthTexture: new THREE.DepthTexture(1, 1) });
  const uniforms = { uTime: { value: 0 }, uAlive: { value: opts.alive ?? 0.5 }, uIntro: { value: 99 }, tSceneDepth: { value: rt.depthTexture }, uInkRes: { value: new THREE.Vector2(1, 1) } };
  const tb = performance.now();
  // Float targets are optional; keep the original analytic shader as a fallback.
  const cacheSpine = renderer.extensions.has('EXT_color_buffer_float') && renderer.capabilities.maxTextureSize >= SPINE_N;
  const motion = knotMotion(knotSpec, cacheSpine);
  motion.intro = uniforms.uIntro;
  const rtSpine = cacheSpine ? new THREE.WebGLRenderTarget(SPINE_N, 4, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter }) : null;
  if (rtSpine) motion.spine.value = rtSpine.texture;
  const mat = styledMaterial(uniforms), wmat = waterMaterial(uniforms), ink = inkMaterial(uniforms);
  const scene = new THREE.Scene();

  // city
  const city = buildCity();
  const cityGroup = new THREE.Group();
  cityGroup.position.set(-4.75, -0.1, -0.55);
  cityGroup.rotation.y = 0.12;
  cityGroup.scale.set(1.06, 1.1, 1.32); // deeper front-to-back, like the painted island
  const water = city.wg.mesh(wmat);
  water.castShadow = false;
  const crownGeos = treeTemplates();
  const cityMesh = city.g.mesh(mat), cityTrees = cityCrowns(city.g.crowns, crownGeos, mat), cityDepth = cityDepthMaterial(uniforms);
  cityMesh.customDepthMaterial = cityDepth; cityTrees.forEach((m) => { m.customDepthMaterial = cityDepth; });
  cityGroup.add(cityMesh, city.g.lines(ink), water, ...cityTrees);
  scene.add(cityGroup);

  const trainMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(PAL.train) });
  const cityTrain = makeTrain(6, 0.15, 0.075, 0.055, trainMat, ink);
  cityTrain.cars.forEach((c) => cityGroup.add(c));
  const boats = Array.from({ length: 5 }, () => makeBoat(ink));
  boats.forEach((b) => cityGroup.add(b));
  const puffs = [];
  if (city.chimneyTop) {
    const pg = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(pg, new THREE.MeshLambertMaterial({ color: new THREE.Color('#ece8e1'), transparent: true, depthWrite: false }));
      cityGroup.add(m); puffs.push(m);
    }
  }

  // knot: the mesh, its ink and its shadow all bend in the vertex shader
  const knot = buildKnot(knotSpec);
  const knotGroup = new THREE.Group();
  const knotMesh = knot.g.mesh(styledMaterial(uniforms, motion)), knotInk = knot.g.lines(inkMaterial(uniforms, motion));
  knotMesh.customDepthMaterial = knotDepthMaterial(uniforms, motion);
  knotMesh.frustumCulled = false; knotInk.frustumCulled = false;
  knotGroup.add(knotMesh, knotInk, ...knotCrowns(knot.crowns, crownGeos, styledMaterial(uniforms, motion, true), knotDepthMaterial(uniforms, motion, true)));
  const knotTrains = [makeTrain(6, 0.14, 0.07, 0.05, trainMat, ink), makeTrain(5, 0.14, 0.07, 0.05, trainMat, ink)];
  knotTrains.forEach((t) => t.cars.forEach((c) => knotGroup.add(c)));
  knotGroup.position.set(6.0, 1.15, 0);
  knotGroup.scale.setScalar(0.92);
  scene.add(knotGroup);
  if (opts.log) console.log('city-and-knot build ms', Math.round(performance.now() - tb), 'baked tris', (city.g.tris + city.wg.tris + knot.g.tris) | 0, 'crowns', city.g.crowns.length, knot.crowns.IV.length);
  // Meshes own their compact buffers; animation only needs the paths below.
  delete city.g; delete city.wg; delete knot.g;

  // light: warm sun, cool sky
  scene.add(new THREE.HemisphereLight(0xf6f6f0, 0xdad0bc, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
  sun.position.set(-10, 17, 12);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 11, bottom: -11, near: 1, far: 60 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.015;
  sun.shadow.radius = 2.5;
  scene.add(sun, sun.target);

  // camera
  const camera = new THREE.PerspectiveCamera(19, 2, 12, 70);
  const target = new THREE.Vector3(0.05, 0.75, 0);
  const EL = 0.7, DIST = 32.5;
  const ISLE_X = 1.4; // between the island and the knot
  // the knot's resting pose: seen nearly face-on (its axis 15 degrees off the
  // line of sight), so the loops read as a wreath round the open centre. Found
  // by matching the outline of a pose Nick turned it to by hand.
  const qBase = new THREE.Quaternion(0.0813, 0.8842, -0.4574, 0.0481).normalize();
  const qW = new THREE.Quaternion(), e = new THREE.Euler();
  const qUser = new THREE.Quaternion(); // how far a reader has turned the knot by hand
  const qIntro = new THREE.Quaternion();
  const movers = [...cityTrain.cars, ...knotTrains.flatMap((k) => k.cars), ...boats, ...puffs];

  // lines on their own layer (see inkMaterial), rendered to their own target
  scene.traverse((o) => { if (o.isLineSegments) o.layers.set(1); });
  const rtInk = new THREE.WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: false });
  const rtWash = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false, colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter }); // mips give the backdrop its halo
  const rtAO = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const wc = { soft: 1.0, drift: 3.0, edge: 0.55, grain: 0.5, line: 1, behind: 0.36, ...(opts.watercolor || {}) };
  const res = new THREE.Vector2(1, 1), pxr = { value: 1 };
  // the island's land field as a texture, for the coast dissolving into the paper
  const lg = city.land, landData = new Uint8Array(lg.nx * lg.nz);
  for (let i = 0; i < landData.length; i++) landData[i] = Math.round(clamp(lg.v[i] / 1.5, 0, 1) * 255);
  const landTex = new THREE.DataTexture(landData, lg.nx, lg.nz, THREE.RedFormat, THREE.UnsignedByteType);
  landTex.magFilter = landTex.minFilter = THREE.LinearFilter; landTex.needsUpdate = true;
  const toCity = new THREE.Matrix4(), cityInv = new THREE.Matrix4();
  cityGroup.updateMatrixWorld(true);
  cityInv.copy(cityGroup.matrixWorld).invert();
  const bl = opts.blend ?? 1;
  const coast = {
    uLand: { value: landTex }, uToCity: { value: toCity }, uIntro: uniforms.uIntro,
    uLandA: { value: new THREE.Vector4(lg.b.x0 - lg.step / 2, lg.b.z0 - lg.step / 2, lg.step * lg.nx, lg.step * lg.nz) },
    uBlend: { value: new THREE.Vector3(bl > 0 ? 1 : 0, 0.02 + 0.1 * bl, 0.3 + 0.35 * bl) },
  };
  Object.assign(uniforms, { uLand: coast.uLand, uLandA: coast.uLandA, uBlend: coast.uBlend }); // read by the city's pen lines when they compile
  const wash = new THREE.ShaderMaterial({
    vertexShader: POST_VERT, fragmentShader: WASH_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tColor: { value: rt.texture }, tDepth: { value: rt.depthTexture }, tAO: { value: rtAO.texture }, uRes: { value: res }, uPx: pxr,
      uNear: { value: camera.near }, uFar: { value: camera.far }, uTime: uniforms.uTime,
      uAO: { value: opts.ao ?? 0.8 }, uSoft: { value: wc.soft }, uDrift: { value: wc.drift }, uBehind: { value: wc.behind }, ...coast,
    },
  });
  const post = new THREE.ShaderMaterial({
    vertexShader: POST_VERT, fragmentShader: POST_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tWash: { value: rtWash.texture }, tInk: { value: rtInk.texture }, tScene: { value: rt.texture }, tDepth: { value: rt.depthTexture }, tAO: { value: rtAO.texture }, uRes: { value: res }, uPx: pxr,
      uNear: { value: camera.near }, uFar: { value: camera.far }, uTime: uniforms.uTime,
      uEdge: { value: wc.edge }, uGran: { value: wc.grain }, uLine: { value: wc.line },
      uPaper: { value: paper.clone() }, uWarm: { value: new THREE.Color('#fcf8ef') }, uInk: { value: new THREE.Color('#3b3129') },
      uIsle: { value: 0.5 }, uBg: { value: opts.backdrop ?? 4 }, uBgVar: { value: opts.backdropVariant ?? 2 }, ...coast,
    },
  });
  reseed(5);
  const kernel = [];
  while (kernel.length < 16) {
    const v = [rnd(-1, 1), rnd(-1, 1), rnd(0.15, 1)];
    if (len3(v) > 1) continue;
    const k = (kernel.length + 1) / 16, sc = 0.12 + 0.88 * k * k;
    kernel.push(new THREE.Vector3(...scl(norm(v), sc)));
  }
  const aoMat = new THREE.ShaderMaterial({
    vertexShader: POST_VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
    uniforms: {
      tDepth: { value: rt.depthTexture }, uProj: { value: camera.projectionMatrix }, uProjInv: { value: camera.projectionMatrixInverse },
      uRes: { value: res }, uRadius: { value: opts.aoRadius ?? 0.34 }, uNear: { value: camera.near }, uFar: { value: camera.far },
      uKernel: { value: kernel }, uTime: uniforms.uTime,
    },
  });
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), plane = new THREE.PlaneGeometry(2, 2);
  const pass = (m) => { const sc = new THREE.Scene(), q = new THREE.Mesh(plane, m); q.frustumCulled = false; sc.add(q); return sc; };
  const aoScene = pass(aoMat), washScene = pass(wash), postScene = pass(post);
  const spineScene = rtSpine ? pass(new THREE.ShaderMaterial({ vertexShader: POST_VERT, fragmentShader: motion.spineFrag, depthTest: false, depthWrite: false, uniforms: { uTime: uniforms.uTime, uAlive: uniforms.uAlive } })) : null;
  renderer.shadowMap.autoUpdate = false; // the ink pass must not redraw the shadows
  const clouds = makeClouds(uniforms, rt, camera, res, pxr, sun, opts.clouds ?? 0.55);

  function frame(t) {
    uniforms.uTime.value = t;
    const alive = uniforms.uAlive.value;
    const az = 0.012 * Math.sin(t * 0.07), el = EL + 0.006 * Math.sin(t * 0.05 + 1);
    camera.position.set(target.x + DIST * Math.sin(az) * Math.cos(el), target.y + DIST * Math.sin(el), target.z + DIST * Math.cos(az) * Math.cos(el));
    camera.lookAt(target);
    camera.updateMatrixWorld();
    toCity.copy(cityInv).multiply(camera.matrixWorld).multiply(camera.projectionMatrixInverse); // screen -> island
    post.uniforms.uIsle.value = _P.set(ISLE_X, 0, 0).project(camera).x * 0.5 + 0.5; // the island's wash may run out left of here

    // the knot as a whole only leans a little; the life is in its strands
    e.set(0.025 * Math.sin(t * 0.11), 0.035 * Math.sin(t * 0.083 + 0.6), 0.02 * Math.sin(t * 0.061 + 2.0));
    qW.setFromEuler(e);
    const it = intro.time(), done = it > INTRO_LEN;
    uniforms.uIntro.value = done ? 99 : it;
    const ke = done ? 1 : easeInOut((it - 0.3) / 4.6);
    knotGroup.scale.setScalar(0.92 * (0.92 + 0.08 * ke));
    qIntro.setFromAxisAngle(_P.copy(target).sub(camera.position).normalize(), -0.25 * (1 - ke)); // it unwinds into place
    knotGroup.quaternion.copy(qIntro).multiply(qUser).multiply(qW).multiply(qBase);
    movers.forEach((m) => { m.visible = done || it > 4.7; });

    { // shuttle between the two sheds: run, dwell, run back, dwell
      const sA = city.SHED * 0.55, sB = city.VF.L - city.SHED * 0.55, run = (sB - sA) / 0.3, dwell = 5, per = 2 * (run + dwell);
      const ph = ((t + 3) % per + per) % per;
      const u = ph < run ? smooth(0, run, ph) : ph < run + dwell ? 1 : ph < 2 * run + dwell ? 1 - smooth(run + dwell, 2 * run + dwell, ph) : 0;
      placeTrain(cityTrain, city.VW, sA + (sB - sA) * u, 0.34 + 0.03, 0);
    }
    const lc = (knot.lane[0] + knot.lane[1]) / 2 + 0.05; // on the rails
    placeKnotTrain(knotTrains[0], knot, motion, (t * 0.3) % knot.L, 0.03, lc, false, t, alive);
    placeKnotTrain(knotTrains[1], knot, motion, ((knot.L * 0.5 - t * 0.26) % knot.L + knot.L) % knot.L, 0.03, lc, true, t, alive);

    boats.forEach((b, i) => {
      const P = city.lakePath, n = P.length, u = ((t * 0.012 + i / boats.length) % 1 + 1) % 1 * n;
      const k = Math.floor(u), a = P[k % n], c = P[(k + 1) % n], w = u - k;
      b.position.set(a[0] + (c[0] - a[0]) * w, -0.02, a[1] + (c[1] - a[1]) * w);
      b.rotation.y = -Math.atan2(c[1] - a[1], c[0] - a[0]);
    });
    puffs.forEach((m, i) => {
      const ph = (t * 0.07 + i / puffs.length) % 1, c = city.chimneyTop;
      m.position.set(c[0] + ph * 0.55 + 0.04 * Math.sin(t * 0.5 + i), c[1] + 0.03 + ph * 0.8, c[2] - ph * 0.18);
      m.scale.setScalar(0.035 + ph * 0.13);
      m.material.opacity = 0.5 * (1 - ph) * Math.min(1, ph * 8);
    });
    if (rtSpine) {
      renderer.setRenderTarget(rtSpine);
      renderer.render(spineScene, postCam);
    }
    renderer.shadowMap.needsUpdate = true;
    camera.layers.set(0);
    renderer.setClearColor(paper, 1);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(rtAO);
    renderer.render(aoScene, postCam);
    camera.layers.set(1);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rtInk);
    renderer.render(scene, camera);
    renderer.setRenderTarget(rtWash);
    renderer.render(washScene, postCam);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
    clouds.update(t, done ? 1 : easeInOut((it - 3.4) / 2.0));
    renderer.autoClear = false;
    renderer.render(clouds.scene, postCam);
    renderer.autoClear = true;
  }

  function resize() {
    const w = container.clientWidth, h = container.clientHeight || w / 2;
    renderer.setSize(w, h, false);
    const dpr = renderer.getPixelRatio(), W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    rt.setSize(W, H); rtInk.setSize(W, H); rtWash.setSize(W, H);
    rtAO.setSize(Math.max(1, W >> 1), Math.max(1, H >> 1));
    res.set(W, H); uniforms.uInkRes.value.set(W, H);
    pxr.value = dpr;
    camera.aspect = w / h;
    camera.fov = 19 * Math.max(1, 2 / camera.aspect);
    camera.updateProjectionMatrix();
  }
  resize();
  // Playback. It runs by default and stops while off screen. The essay's shared
  // pause control sits in the top-right corner; readers who ask their system for
  // reduced motion (or who already paused a figure on this page) start paused.
  let visible = true, raf = 0, paused = false, tNow = opts.startAt || 0, t0 = 0;
  const frameInterval = 1000 / 30;
  let nextFrameAt = 0;
  const loop = (now) => {
    raf = 0;
    if (!visible || paused) return;
    if (!nextFrameAt) nextFrameAt = now;
    if (now + 1 >= nextFrameAt) {
      nextFrameAt += frameInterval;
      if (nextFrameAt <= now) nextFrameAt = now + frameInterval;
      tNow = (performance.now() - t0) / 1000 * SPEED;
      turn.step();
      frame(tNow);
    }
    raf = requestAnimationFrame(loop);
  };
  const run = () => { t0 = performance.now() - tNow * 1000 / SPEED; nextFrameAt = 0; if (!raf) raf = requestAnimationFrame(loop); };
  new ResizeObserver(() => { resize(); if (fixedTime !== null) frame(fixedTime); else if (paused) frame(tNow); }).observe(container);

  // An easter egg: the knot can be picked up. Over it the cursor becomes a
  // hand; dragging rolls it like a trackball, and when let go it coasts, then
  // drifts back to where the drawing wants it. Works while paused too.
  const turn = (() => {
    const spin = new THREE.Vector3(), axis = new THREE.Vector3(), dq = new THREE.Quaternion(), rest = new THREE.Quaternion();
    const camUp = new THREE.Vector3(), camRight = new THREE.Vector3(), c0 = new THREE.Vector3(), c1 = new THREE.Vector3();
    let held = false, lx = 0, ly = 0, last = performance.now(), still = 0, pokeRaf = 0;
    const trail = []; // the pointer's recent path, [event time ms, x, y], for the speed of a throw
    const reach = (knotSpec.R + knotSpec.r * 1.3) * knotGroup.scale.x;
    const over = (ev) => { // is the pointer on the knot's disc?
      const r = canvas.getBoundingClientRect();
      c0.copy(knotGroup.position).project(camera);
      c1.copy(camRight.setFromMatrixColumn(camera.matrixWorld, 0)).multiplyScalar(reach).add(knotGroup.position).project(camera);
      const cx = r.left + (c0.x * 0.5 + 0.5) * r.width, cy = r.top + (0.5 - c0.y * 0.5) * r.height;
      const rad = Math.abs(c1.x - c0.x) * 0.5 * r.width;
      return Math.hypot(ev.clientX - cx, ev.clientY - cy) < rad;
    };
    const rotate = (dx, dy) => { // screen pixels -> a turn about the camera's own axes
      camUp.setFromMatrixColumn(camera.matrixWorld, 1); camRight.setFromMatrixColumn(camera.matrixWorld, 0);
      axis.copy(camUp).multiplyScalar(dx).addScaledVector(camRight, dy);
      const ang = axis.length() * 0.0075;
      if (ang < 1e-6) return 0;
      axis.normalize();
      qUser.premultiply(dq.setFromAxisAngle(axis, ang));
      return ang;
    };
    const show = () => { if ((paused || fixedTime !== null || !visible) && !pokeRaf) pokeRaf = requestAnimationFrame(poke); };
    const poke = () => { pokeRaf = 0; const busy = step(); frame(fixedTime ?? tNow); if (busy) show(); };
    function step() { // inertia, then a slow return; true while still moving
      const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (held) return true;
      const w = spin.length();
      if (w > 1e-3) { axis.copy(spin).normalize(); qUser.premultiply(dq.setFromAxisAngle(axis, w * dt)); spin.multiplyScalar(Math.exp(-dt * 1.7)); still = now; return true; }
      if (1 - Math.abs(qUser.dot(rest)) < 5e-7) { qUser.identity(); return false; } // home
      if (now - still > 1400) qUser.slerp(rest, 1 - Math.exp(-dt * 0.9)); // after a moment's rest it drifts back
      return true;
    }
    canvas.style.touchAction = 'pan-y'; // sideways drags turn it on a phone; up and down still scroll
    const note = (e) => { trail.push([e.timeStamp, e.clientX, e.clientY]); while (trail.length > 2 && trail[1][0] < e.timeStamp - 200) trail.shift(); };
    canvas.addEventListener('pointermove', (ev) => { if (!held) canvas.style.cursor = over(ev) ? 'grab' : ''; });
    // While held, the drag is followed anywhere on the page, not just over the figure.
    window.addEventListener('pointermove', (ev) => {
      if (!held) return;
      if (ev.pointerType === 'mouse' && !(ev.buttons & 1)) { release(ev); return; } // the button came up somewhere we never heard about
      // every sample the browser gathered since the last event, not only the last one,
      // so a busy frame does not lose the motion
      const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [];
      for (const e of evs.length ? evs : [ev]) { rotate(e.clientX - lx, e.clientY - ly); lx = e.clientX; ly = e.clientY; note(e); }
      show();
    }, true);
    canvas.addEventListener('pointerdown', (ev) => {
      if (!over(ev)) return;
      held = true; lx = ev.clientX; ly = ev.clientY; spin.set(0, 0, 0); trail.length = 0; note(ev);
      canvas.setPointerCapture(ev.pointerId); canvas.style.cursor = 'grabbing'; ev.preventDefault();
    });
    // Let go: throw it with the pointer's speed over its last tenth of a
    // second, timed by the events themselves. If the hand had stopped before
    // letting go, it stays where it was put.
    const throwSpeed = (tEnd) => {
      let i = trail.length - 1;
      if (i < 1 || trail[i][0] < tEnd - 100) return [0, 0];
      while (i > 0 && trail[i - 1][0] >= tEnd - 100) i--;
      const a = trail[Math.max(0, i - 1)], b = trail[trail.length - 1], dt = Math.max(16, tEnd - a[0]) / 1000;
      return [(b[1] - a[1]) / dt, (b[2] - a[2]) / dt];
    };
    const release = (ev, thrown = true) => {
      if (!held) return;
      held = false; still = performance.now(); canvas.style.cursor = 'grab';
      const [vx, vy] = thrown ? throwSpeed(ev.timeStamp) : [0, 0], v = Math.hypot(vx, vy);
      spin.set(0, 0, 0);
      if (v > 40) { // pixels per second
        camUp.setFromMatrixColumn(camera.matrixWorld, 1); camRight.setFromMatrixColumn(camera.matrixWorld, 0);
        spin.copy(camUp).multiplyScalar(vx).addScaledVector(camRight, vy).normalize().multiplyScalar(Math.min(v * 0.0075, 9));
      }
      try { canvas.releasePointerCapture(ev.pointerId); } catch (err) { /* already released */ }
      show();
    };
    // letting go counts wherever it happens: over the figure, elsewhere on the page,
    // or when the browser takes the pointer away (a scroll, a lost capture, the window losing focus)
    window.addEventListener('pointerup', (ev) => release(ev), true);
    window.addEventListener('pointercancel', (ev) => release(ev, false), true);
    canvas.addEventListener('lostpointercapture', (ev) => release(ev));
    window.addEventListener('blur', () => release({ timeStamp: performance.now(), pointerId: -1 }, false));
    return {
      step,
      reset() {
        held = false; spin.set(0, 0, 0); trail.length = 0;
        cancelAnimationFrame(pokeRaf); pokeRaf = 0;
        last = still = performance.now();
        qUser.identity(); canvas.style.cursor = '';
      },
    };
  })();
  // The first appearance. Plays once per visitor (remembered), the first time
  // the figure is on screen; readers who ask for reduced motion skip it, and it
  // can always be replayed.
  const intro = (() => {
    let start = -1, frozen = null, raf = 0, heldAt = null;
    const time = () => frozen ?? heldAt ?? (start < 0 ? 99 : (performance.now() - start) / 1000);
    const tick = () => { raf = 0; if (heldAt !== null) return; if (time() > INTRO_LEN) { frame(fixedTime ?? tNow); return; } if (paused || !visible) frame(tNow); raf = requestAnimationFrame(tick); };
    return {
      time,
      play() {
        // Keep the old picture hidden while drawing the intro's first frame.
        canvas.style.transition = 'none'; canvas.style.opacity = 0; void canvas.offsetWidth;
        frozen = heldAt = null; start = performance.now();
        // Replay the same scene as a first visit, including the movers and camera.
        tNow = opts.startAt || 0; t0 = start - tNow * 1000 / SPEED; nextFrameAt = 0;
        turn.reset();
        frame(fixedTime ?? tNow);
        canvas.style.transition = 'opacity 1.8s cubic-bezier(.55, 0, .35, 1)'; canvas.style.opacity = 1;
        if (!raf) raf = requestAnimationFrame(tick);
      },
      hold() { // the pause button freezes the intro too, fade and all
        if (start < 0 || heldAt !== null || time() > INTRO_LEN) return;
        heldAt = time(); cancelAnimationFrame(raf); raf = 0;
        const o = getComputedStyle(canvas).opacity; canvas.style.transition = 'none'; canvas.style.opacity = o;
      },
      resume() {
        if (heldAt === null) return;
        const at = heldAt; heldAt = null; start = performance.now() - at * 1000;
        canvas.style.transition = `opacity ${Math.max(0.2, 1.8 - at).toFixed(2)}s ease-out`; canvas.style.opacity = 1;
        if (!raf) raf = requestAnimationFrame(tick);
      },
      freeze(sec) { frozen = sec; frame(fixedTime ?? tNow); }, // for stills of a moment in the intro
    };
  })();
  let seen = true;
  try { seen = localStorage.getItem(INTRO_KEY) === '1'; } catch (err) { /* storage blocked: treat as seen */ }
  const wantIntro = fixedTime === null && opts.intro !== 'never' && (opts.intro === 'always' || (!seen && !reduce));
  if (!wantIntro) requestAnimationFrame(() => { canvas.style.opacity = 1; });
  else {
    canvas.style.transition = 'none'; canvas.style.opacity = 0;
    uniforms.uIntro.value = -1; // keep the paper blank until it starts
    const io = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      if (paused) {
        frame(tNow);
        // Show an initial still without overriding a fade the reader paused.
        if (intro.time() > INTRO_LEN) canvas.style.opacity = 1;
        return;
      }
      intro.play();
      try { localStorage.setItem(INTRO_KEY, '1'); } catch (err) { /* not remembered */ }
    }, { threshold: 0.35 });
    io.observe(container);
  }

  let control = null;
  const setPaused = (p) => { // pausing stops the loop (and the intro) and keeps the current frame
    paused = p;
    if (control) control.set(p);
    if (p) { intro.hold(); frame(tNow); } else { intro.resume(); run(); }
  };
  const replayIntro = () => { if (paused) setPaused(false); intro.play(); }; // asking for the intro means motion
  if (fixedTime !== null) frame(fixedTime);
  else {
    control = pauseControl(container, () => setPaused(true), () => setPaused(false), replayIntro);
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible && !paused) run(); }).observe(container);
    setPaused(control ? control.startsPaused() : reduce);
  }
  if (wantIntro) frame(tNow); // prepare the drawing while it is hidden
  return { renderer, scene, camera, frame, uniforms, pause: () => setPaused(true), play: () => setPaused(false), qUser, replayIntro, introAt: (sec) => intro.freeze(sec) };
}

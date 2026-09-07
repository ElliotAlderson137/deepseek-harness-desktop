// Render the DeepSeek whale favicon path (the same silhouette DeepSeek Harness
// uses in black) as a blue -> black gradient whale, then emit:
//   build/icon.png (512px) and build/icon.ico (256px, PNG-compressed ICO)
// Zero dependencies: hand-rolled SVG path parser + rasterizer + PNG encoder.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });

// ================= PNG encoding =================
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xffffffff;
  for (const b of buf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ================= SVG path parsing =================
function tokenize(d) {
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][+-]?\d+)?)/g;
  const out = [];
  let m;
  while ((m = re.exec(d))) out.push(m[1] || parseFloat(m[2]));
  return out;
}

function pushCubic(pts, x0, y0, x1, y1, x2, y2, x3, y3, eps) {
  const flat = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const d1 = Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by);
    const d2 = Math.hypot(dx - ax, dy - ay);
    if (d1 - d2 <= eps) {
      pts.push(dx, dy);
      return;
    }
    const abx = (ax + bx) / 2, aby = (ay + by) / 2;
    const bcx = (bx + cx) / 2, bcy = (by + cy) / 2;
    const cdx = (cx + dx) / 2, cdy = (cy + dy) / 2;
    const abcx = (abx + bcx) / 2, abcy = (aby + bcy) / 2;
    const bcdx = (bcx + cdx) / 2, bcdy = (bcy + cdy) / 2;
    const mx = (abcx + bcdx) / 2, my = (abcy + bcdy) / 2;
    flat(ax, ay, abx, aby, abcx, abcy, mx, my);
    flat(mx, my, bcdx, bcdy, cdx, cdy, dx, dy);
  };
  pts.push(x0, y0);
  flat(x0, y0, x1, y1, x2, y2, x3, y3);
}

function pushQuad(pts, x0, y0, x1, y1, x2, y2, eps) {
  const q = (ax, ay, bx, by, cx, cy) => {
    const d1 = Math.hypot(bx - ax, by - ay) + Math.hypot(cx - bx, cy - by);
    const d2 = Math.hypot(cx - ax, cy - ay);
    if (d1 - d2 <= eps) {
      pts.push(cx, cy);
      return;
    }
    const abx = (ax + bx) / 2, aby = (ay + by) / 2;
    const bcx = (bx + cx) / 2, bcy = (by + cy) / 2;
    const mx = (abx + bcx) / 2, my = (aby + bcy) / 2;
    q(ax, ay, abx, aby, mx, my);
    q(mx, my, bcx, bcy, cx, cy);
  };
  pts.push(x0, y0);
  q(x0, y0, x1, y1, x2, y2);
}

/**
 * Parse an SVG path `d` into closed subpaths of flattened [x,y,x,y,...] points.
 * @param {string} d - path data
 * @param {number} scale - output scale (multiplied into coordinates)
 * @param {number} tx,ty - translation
 * @returns {number[][]} array of subpaths
 */
function parsePath(d, scale, tx, ty) {
  const X = (v) => v * scale + tx;
  const Y = (v) => v * scale + ty;
  const toks = tokenize(d);
  const subpaths = [];
  let pts = null;
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let cmd = null;
  let lastCtrl = null;
  let i = 0;
  const isNum = () => i < toks.length && typeof toks[i] === 'number';
  const num = () => {
    if (!isNum()) throw new Error('expected number at token ' + i);
    return toks[i++];
  };
  const finishSubpath = () => {
    if (pts && pts.length >= 4) {
      // close explicitly if not already
      if (pts[0] !== pts[pts.length - 2] || pts[1] !== pts[pts.length - 1]) {
        pts.push(pts[0], pts[1]);
      }
      subpaths.push(pts);
    }
    pts = null;
  };
  while (i < toks.length) {
    const t = toks[i];
    if (typeof t === 'string') {
      i++;
      if (t === 'Z' || t === 'z') {
        if (pts) {
          pts.push(sx, sy); // explicit close
          finishSubpath();
        }
        cx = sx; cy = sy;
        lastCtrl = null;
        continue;
      }
      cmd = t;
      if (cmd === 'M' || cmd === 'm') {
        finishSubpath();
        pts = [];
        const px = num(), py = num();
        cx = cmd === 'm' ? cx + px : px;
        cy = cmd === 'm' ? cy + py : py;
        sx = cx; sy = cy;
        pts.push(X(cx), Y(cy));
        lastCtrl = null;
        // following pairs are implicit L/l — handled by loop with cmd updated:
        cmd = cmd === 'M' ? 'L' : 'l';
        continue;
      }
      continue;
    }
    if (!pts) throw new Error('numbers before any M');
    switch (cmd) {
      case 'L': case 'l': {
        const px = num(), py = num();
        cx = cmd === 'l' ? cx + px : px;
        cy = cmd === 'l' ? cy + py : py;
        pts.push(X(cx), Y(cy));
        lastCtrl = null;
        break;
      }
      case 'H': case 'h': {
        const px = num();
        cx = cmd === 'h' ? cx + px : px;
        pts.push(X(cx), Y(cy));
        lastCtrl = null;
        break;
      }
      case 'V': case 'v': {
        const py = num();
        cy = cmd === 'v' ? cy + py : py;
        pts.push(X(cx), Y(cy));
        lastCtrl = null;
        break;
      }
      case 'C': case 'c': {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x3 = num(), y3 = num();
        const ax = cx, ay = cy;
        const bx = cmd === 'c' ? ax + x1 : x1, by = cmd === 'c' ? ay + y1 : y1;
        const ccx = cmd === 'c' ? ax + x2 : x2, ccy = cmd === 'c' ? ay + y2 : y2;
        const dx = cmd === 'c' ? ax + x3 : x3, dy = cmd === 'c' ? ay + y3 : y3;
        pushCubic(pts, X(ax), Y(ay), X(bx), Y(by), X(ccx), Y(ccy), X(dx), Y(dy), 0.4);
        cx = dx; cy = dy;
        lastCtrl = [ccx, ccy];
        break;
      }
      case 'S': case 's': {
        const x2 = num(), y2 = num(), x3 = num(), y3 = num();
        const ax = cx, ay = cy;
        const bx = lastCtrl ? 2 * ax - lastCtrl[0] : ax;
        const by = lastCtrl ? 2 * ay - lastCtrl[1] : ay;
        const ccx = cmd === 's' ? ax + x2 : x2, ccy = cmd === 's' ? ay + y2 : y2;
        const dx = cmd === 's' ? ax + x3 : x3, dy = cmd === 's' ? ay + y3 : y3;
        pushCubic(pts, X(ax), Y(ay), X(bx), Y(by), X(ccx), Y(ccy), X(dx), Y(dy), 0.4);
        cx = dx; cy = dy;
        lastCtrl = [ccx, ccy];
        break;
      }
      case 'Q': case 'q': {
        const x1 = num(), y1 = num(), x2 = num(), y2 = num();
        const ax = cx, ay = cy;
        const bx = cmd === 'q' ? ax + x1 : x1, by = cmd === 'q' ? ay + y1 : y1;
        const dx = cmd === 'q' ? ax + x2 : x2, dy = cmd === 'q' ? ay + y2 : y2;
        pushQuad(pts, X(ax), Y(ay), X(bx), Y(by), X(dx), Y(dy), 0.4);
        cx = dx; cy = dy;
        lastCtrl = [bx, by];
        break;
      }
      case 'T': case 't': {
        const x2 = num(), y2 = num();
        const ax = cx, ay = cy;
        const bx = lastCtrl ? 2 * ax - lastCtrl[0] : ax;
        const by = lastCtrl ? 2 * ay - lastCtrl[1] : ay;
        const dx = cmd === 't' ? ax + x2 : x2, dy = cmd === 't' ? ay + y2 : y2;
        pushQuad(pts, X(ax), Y(ay), X(bx), Y(by), X(dx), Y(dy), 0.4);
        cx = dx; cy = dy;
        lastCtrl = [bx, by];
        break;
      }
      case 'A': case 'a': {
        // arcs are approximated by a straight chord (rare in flat logos)
        for (let k = 0; k < 5; k++) num();
        const x2 = num(), y2 = num();
        const dx = cmd === 'a' ? cx + x2 : x2, dy = cmd === 'a' ? cy + y2 : y2;
        pts.push(X(dx), Y(dy));
        cx = dx; cy = dy;
        lastCtrl = null;
        break;
      }
      default:
        throw new Error('unsupported command ' + cmd);
    }
  }
  finishSubpath();
  return subpaths;
}

// ================= rasterization =================
function signedArea(poly) {
  let s = 0;
  for (let i = 0; i + 3 < poly.length; i += 2) {
    s += poly[i] * poly[i + 3] - poly[i + 1] * poly[i + 2];
  }
  return s / 2;
}

function windingAt(poly, px, py) {
  let w = 0;
  for (let i = 0; i + 3 < poly.length; i += 2) {
    const x1 = poly[i], y1 = poly[i + 1];
    const x2 = poly[i + 2], y2 = poly[i + 3];
    const cross = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
    if (y1 <= py) {
      if (y2 > py && cross > 0) w++;
    } else if (y2 <= py && cross < 0) w--;
  }
  return w;
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const GRAD = [
  [0.0, hex('#6f8dff')],
  [0.3, hex('#4d6bfe')],
  [0.58, hex('#31409f')],
  [0.82, hex('#131a42')],
  [1.0, hex('#04060d')]
];
const WHITE = hex('#ffffff');

function colorAt(t) {
  if (t <= 0) return GRAD[0][1];
  if (t >= 1) return GRAD[GRAD.length - 1][1];
  for (let i = 0; i < GRAD.length - 1; i++) {
    const [t0, c0] = GRAD[i];
    const [t1, c1] = GRAD[i + 1];
    if (t <= t1) {
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k];
    }
  }
  return GRAD[GRAD.length - 1][1];
}

function render(size, subpaths) {
  // classify outer vs holes by signed area
  const areas = subpaths.map(signedArea);
  const absAreas = areas.map(Math.abs);
  let maxIdx = 0;
  for (let i = 1; i < absAreas.length; i++) if (absAreas[i] > absAreas[maxIdx]) maxIdx = i;
  const outerSign = Math.sign(areas[maxIdx]) || 1;
  const outerArea = Math.abs(areas[maxIdx]);
  const items = subpaths.map((p, i) => ({
    p,
    area: areas[i],
    hole: areas[i] !== 0 && Math.sign(areas[i]) !== outerSign
  }));

  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const it of items)
    for (let i = 0; i < it.p.length; i += 2) {
      if (it.p[i] < xmin) xmin = it.p[i];
      if (it.p[i] > xmax) xmax = it.p[i];
      if (it.p[i + 1] < ymin) ymin = it.p[i + 1];
      if (it.p[i + 1] > ymax) ymax = it.p[i + 1];
    }
  console.log('whale bbox:', { xmin: xmin.toFixed(1), xmax: xmax.toFixed(1), ymin: ymin.toFixed(1), ymax: ymax.toFixed(1) });
  console.log('subpaths:', subpaths.length, '| holes:', items.filter((i) => i.hole).length);

  // Holes: report their bboxes/areas so we can tell the big interior cut from
  // small decorations (eye / spout). Holes smaller than 4% of the outer area
  // are painted white; bigger ones are treated as body (gradient-filled).
  for (const it of items) {
    if (!it.hole) continue;
    let hxmin = Infinity, hymin = Infinity, hxmax = -Infinity, hymax = -Infinity;
    for (let i = 0; i < it.p.length; i += 2) {
      if (it.p[i] < hxmin) hxmin = it.p[i];
      if (it.p[i] > hxmax) hxmax = it.p[i];
      if (it.p[i + 1] < hymin) hymin = it.p[i + 1];
      if (it.p[i + 1] > hymax) hymax = it.p[i + 1];
    }
    const w = hxmax - hxmin, h = hymax - hymin;
    console.log(
      `hole: bbox x=${hxmin.toFixed(0)}..${hxmax.toFixed(0)} y=${hymin.toFixed(0)}..${hymax.toFixed(0)} (${w.toFixed(0)}x${h.toFixed(0)}) areaFrac=${(Math.abs(it.area) / outerArea * 100).toFixed(1)}%`
    );
  }

  const rgba = Buffer.alloc(size * size * 4);
  const SS = 2;
  const NS = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inWhale = 0;
      let inDeco = 0;
      let inMouth = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          for (const it of items) {
            if (windingAt(it.p, px, py) === 0) continue;
            if (!it.hole) { inWhale++; continue; }
            // hole: a big interior cut is the whale's open mouth (must stay
            // VISIBLE — paint it white); small holes are the eye / spout (white
            // decorations). Filling the mouth with body colour hid it entirely.
            if (Math.abs(it.area) / outerArea > 0.04) inMouth++;
            else inDeco++;
          }
        }
      }
      const o = (y * size + x) * 4;
      if (inDeco > 0) {
        const a = Math.min(1, inDeco / NS);
        rgba[o] = WHITE[0]; rgba[o + 1] = WHITE[1]; rgba[o + 2] = WHITE[2];
        rgba[o + 3] = Math.round(a * 255);
      } else if (inMouth > 0) {
        // mouth opening: soft white so it reads on both light & dark desktops
        const a = Math.max(inMouth / NS, 0.88);
        rgba[o] = WHITE[0]; rgba[o + 1] = WHITE[1]; rgba[o + 2] = WHITE[2];
        rgba[o + 3] = Math.round(Math.min(1, a) * 255);
      } else if (inWhale > 0) {
        const a = Math.min(1, inWhale / NS);
        const t = ymax === ymin ? 0.5 : (y + 0.5 - ymin) / (ymax - ymin);
        const c = colorAt(t);
        rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2];
        rgba[o + 3] = Math.round(a * 255);
      } else {
        rgba[o + 3] = 0;
      }
    }
  }
  return { rgba, items };
}

// ================= main =================
const svgSrc = process.argv[2] || path.join(buildDir, 'whale-src.svg');
const svg = fs.readFileSync(svgSrc, 'utf8');
const dMatch = svg.match(/<path[^>]*\bd="([^"]*)"/);
if (!dMatch) throw new Error('no <path d=...> found in ' + svgSrc);

// First parse at 1:1 to find the whale bounding box, then render each target
// size centred with near-full coverage (~96% of canvas) so the whale fills the
// icon area on the desktop, taskbar and tray (was ~80%, which looked small).
const probe = parsePath(dMatch[1], 1, 0, 0);
let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
for (const p of probe)
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < xmin) xmin = p[i];
    if (p[i] > xmax) xmax = p[i];
    if (p[i + 1] < ymin) ymin = p[i + 1];
    if (p[i + 1] > ymax) ymax = p[i + 1];
  }
const w0 = xmax - xmin, h0 = ymax - ymin;

function renderSize(size) {
  const scale = (size * 0.96) / Math.max(w0, h0);
  const tx = size / 2 - ((xmin + xmax) / 2) * scale;
  const ty = size / 2 - ((ymin + ymax) / 2) * scale;
  const subpaths = parsePath(dMatch[1], scale, tx, ty);
  return render(size, subpaths).rgba;
}

const SIZE = 512;
const rgba = renderSize(SIZE);

// ASCII preview (#'= whale, '.' = white eye/spout/mouth)
{
  const W = 70, H = 32;
  let art = '';
  for (let py = 0; py < H; py++) {
    let row = '';
    for (let px = 0; px < W; px++) {
      const x = Math.floor((px + 0.5) * SIZE / W);
      const y = Math.floor((py + 0.5) * SIZE / H);
      const o = (y * SIZE + x) * 4;
      const a = rgba[o + 3];
      row += a < 30 ? ' ' : a > 200 && rgba[o] > 190 && rgba[o + 1] > 190 && rgba[o + 2] > 190 ? '.' : '#';
    }
    art += row + '\n';
  }
  console.log(art);
}

fs.writeFileSync(path.join(buildDir, 'icon.png'), encodePng(SIZE, rgba));
console.log('wrote build/icon.png (512px)');

// Multi-resolution ICO (16/24/32/48/64/128/256) — desktop uses the matching
// size directly, so the icon is not scaled down from a single 256 image.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = ICO_SIZES.map((s) => ({ size: s, buf: encodePng(s, renderSize(s)) }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
// layout: header | contiguous directory entries | all image data
const dirs = [];
const datas = [];
let offset = 6 + 16 * pngs.length;
for (const { size, buf } of pngs) {
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;
  entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(buf.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += buf.length;
  dirs.push(entry);
  datas.push(buf);
}
fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, ...dirs, ...datas]));
console.log('wrote build/icon.ico (' + ICO_SIZES.join('/') + 'px)');

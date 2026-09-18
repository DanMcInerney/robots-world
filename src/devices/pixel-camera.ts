import { deflateSync, inflateSync } from 'node:zlib';
import type { BodySpec, Pose, Vec3 } from '../contracts.ts';
import { add, rotate, sub, vec } from '../math.ts';
import { radians } from './aim-camera.ts';
import { markerPattern, MARKER, type Calibration, type PixelFrame } from '../perception/fiducial.ts';

export type CameraPose = { position: Vec3; headingDeg: number; pitchDeg: number; hfovDeg: number };
export type MarkerSurface = { bodyId: string; pose: Pose; sizeM: number; markerId: number };
/** Small software renderer for box worlds and printed planes. Pixels are the ONLY detector input.
 * Deliberately no object IDs, perfect corners, depth buffers or visibility hints cross that boundary.
 */
export function renderCamera(bodies: BodySpec[], markers: MarkerSurface[], camera: CameraPose, width = 640, height = 360): { image: PixelFrame; calibration: Calibration } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 32 || height < 32 || width > 1920 || height > 1080) throw new Error('Invalid render dimensions');
  const f = width / (2 * Math.tan(radians(camera.hfovDeg) / 2)), k = { fx: f, fy: f, cx: width / 2, cy: height / 2 };
  const data = new Uint8Array(width * height * 4), zbuffer = new Float64Array(width * height).fill(Infinity);
  for (let i = 0; i < data.length; i += 4) { data[i] = 115; data[i + 1] = 130; data[i + 2] = 145; data[i + 3] = 255; }
  const h = radians(camera.headingDeg), p = radians(camera.pitchDeg);
  const view = (point: Vec3) => { const d = sub(point, camera.position); return vec(d.x * Math.sin(h) - d.y * Math.cos(h), -d.x * Math.cos(h) * Math.sin(p) - d.y * Math.sin(h) * Math.sin(p) + d.z * Math.cos(p), d.x * Math.cos(h) * Math.cos(p) + d.y * Math.sin(h) * Math.cos(p) + d.z * Math.sin(p)); };
  const triangle = (points: Vec3[], color: number[]) => {
    let poly = points.map(view), clipped: Vec3[] = [];
    for (let i = 0; i < poly.length; i++) { const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
      if (a.z >= .03) clipped.push(a);
      if ((a.z >= .03) !== (b.z >= .03)) { const t = (.03 - a.z) / (b.z - a.z); clipped.push(vec(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, .03)); }
    }
    for (let n = 1; n + 1 < clipped.length; n++) {
      const projected = [clipped[0]!, clipped[n]!, clipped[n + 1]!].map(v => ({ x: k.cx + f * v.x / v.z, y: k.cy - f * v.y / v.z, z: v.z }));
      const [a, b, c] = projected as [Vec3, Vec3, Vec3], area = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
      if (Math.abs(area) < 1e-8) continue;
      const xmin = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x))), xmax = Math.min(width - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
      const ymin = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y))), ymax = Math.min(height - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
      for (let y = ymin; y <= ymax; y++) for (let x = xmin; x <= xmax; x++) {
        const u = ((b.y - c.y) * (x + .5 - c.x) + (c.x - b.x) * (y + .5 - c.y)) / area;
        const v = ((c.y - a.y) * (x + .5 - c.x) + (a.x - c.x) * (y + .5 - c.y)) / area, w = 1 - u - v;
        if (u < -1e-8 || v < -1e-8 || w < -1e-8) continue;
        const z = 1 / (u / a.z + v / b.z + w / c.z), index = y * width + x;
        if (z >= zbuffer[index]!) continue;
        zbuffer[index] = z; for (let channel = 0; channel < 3; channel++) data[index * 4 + channel] = color[channel]!;
      }
    }
  };
  const quad = (corners: Vec3[], color: number[]) => { triangle([corners[0]!, corners[1]!, corners[2]!], color); triangle([corners[0]!, corners[2]!, corners[3]!], color); };
  for (const body of bodies) {
    if (body.shape.kind !== 'box') throw new Error('Pixel camera renderer supports boxes only; unsupported shape is not silently invisible');
    const s = body.shape.size, vertices = Array.from({ length: 8 }, (_, i) => add(body.pose.position, rotate(vec((i & 1 ? 1 : -1) * s.x / 2, (i & 2 ? 1 : -1) * s.y / 2, (i & 4 ? 1 : -1) * s.z / 2), body.pose.rotation)));
    const hex = (body.shape.color ?? '#808080').replace('#', ''), rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    for (const face of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) quad(face.map(i => vertices[i]!), rgb);
  }
  for (const marker of markers) {
    const pattern = markerPattern(marker.markerId), side = pattern.length, cell = marker.sizeM / (side - 2);
    const normal = rotate(vec(0, 0, 1), marker.pose.rotation), toCamera = sub(camera.position, marker.pose.position);
    if (normal.x * toCamera.x + normal.y * toCamera.y + normal.z * toCamera.z <= 0) continue;
    for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
      const point = (dx: number, dy: number) => add(marker.pose.position, rotate(vec((x + dx - side / 2) * cell, (side / 2 - y - dy) * cell, 0), marker.pose.rotation));
      const gray = pattern[y]![x]!; quad([point(0, 0), point(1, 0), point(1, 1), point(0, 1)], [gray, gray, gray]);
    }
  }
  return { image: { width, height, data }, calibration: k };
}
/** Lossless evidence image. PNG input is exactly the RGBA buffer passed to perception. */
export function framePng(image: PixelFrame): Buffer {
  const crc = (bytes: Uint8Array) => { let n = 0xffffffff; for (const b of bytes) { n ^= b; for (let i = 0; i < 8; i++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1; } return (n ^ 0xffffffff) >>> 0; };
  const chunk = (name: string, bytes: Buffer) => { const type = Buffer.from(name), header = Buffer.alloc(4), end = Buffer.alloc(4); header.writeUInt32BE(bytes.length); end.writeUInt32BE(crc(Buffer.concat([type, bytes]))); return Buffer.concat([header, type, bytes, end]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(image.width); header.writeUInt32BE(image.height, 4); header[8] = 8; header[9] = 6;
  const stride = image.width * 4, rows = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) rows.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
/** Decode our lossless RGBA evidence format for independent offline perception replay. */
export function readFramePng(png: Uint8Array): PixelFrame {
  const b = Buffer.from(png);
  if (b.length < 33 || b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || b.toString('ascii', 12, 16) !== 'IHDR' || b[24] !== 8 || b[25] !== 6 || b[28] !== 0) throw new Error('Unsupported evidence PNG');
  const width = b.readUInt32BE(16), height = b.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1920 || height > 1080) throw new Error('PNG dimensions exceed evidence bound');
  const parts: Buffer[] = [];
  for (let offset = 8; offset < b.length;) { const size = b.readUInt32BE(offset); if (offset + size + 12 > b.length) throw new Error('Truncated PNG'); if (b.toString('ascii', offset + 4, offset + 8) === 'IDAT') parts.push(b.subarray(offset + 8, offset + 8 + size)); offset += size + 12; }
  const stride = width * 4, rows = inflateSync(Buffer.concat(parts), { maxOutputLength: (stride + 1) * height });
  if (rows.length !== (stride + 1) * height) throw new Error('Invalid PNG row length');
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) { if (rows[y * (stride + 1)] !== 0) throw new Error('Unsupported PNG filter'); data.set(rows.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride); }
  return { width, height, data };
}

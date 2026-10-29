import { inflateSync } from "node:zlib";

export interface RgbaPixels {
  readonly width: number;
  readonly height: number;
  readonly channels: 4;
  readonly data: Uint8Array;
  readonly iccProfile: Uint8Array | null;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Decode a non-interlaced 8-bit PNG (gray, RGB, palette, gray+alpha, RGBA) to RGBA8.
 * Upstream Bun.Image has no raw-pixel terminal; this turns its PNG output into pixels
 * without any native addon. Anything else (16-bit, Adam7) is rejected, not guessed.
 */
export function decodePngToRgba(png: Uint8Array, maxPixels = 268_435_456): RgbaPixels {
  if (png.length < 33 || SIGNATURE.some((byte, i) => png[i] !== byte)) throw new TypeError("Not a PNG image");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let transparency: Uint8Array | null = null;
  let icc: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 12 <= png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(png[offset + 4]!, png[offset + 5]!, png[offset + 6]!, png[offset + 7]!);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new TypeError("Truncated PNG chunk");
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      depth = png[offset + 16]!;
      colorType = png[offset + 17]!;
      interlace = png[offset + 20]!;
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "iCCP") {
      const nul = body.indexOf(0);
      if (nul >= 0 && body[nul + 1] === 0) icc = new Uint8Array(inflateSync(body.subarray(nul + 2)));
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!width || !height) throw new TypeError("PNG has no IHDR");
  if (width * height > maxPixels) throw new RangeError("PNG exceeds the pixel limit");
  if (depth !== 8 || interlace !== 0) throw new TypeError("Only non-interlaced 8-bit PNG is supported");
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const samples = channelsByType[colorType];
  if (!samples) throw new TypeError(`Unsupported PNG color type ${colorType}`);
  if (colorType === 3 && !palette) throw new TypeError("Indexed PNG has no palette");

  const compressed = new Uint8Array(idat.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of idat) {
    compressed.set(chunk, at);
    at += chunk.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));
  const stride = width * samples;
  if (raw.length < (stride + 1) * height) throw new TypeError("Truncated PNG pixel data");

  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= samples ? rows[dst + x - samples]! : 0;
      const b = y > 0 ? rows[dst - stride + x]! : 0;
      const c = x >= samples && y > 0 ? rows[dst - stride + x - samples]! : 0;
      let value = raw[src + x]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          value += a;
          break;
        case 2:
          value += b;
          break;
        case 3:
          value += (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new TypeError(`Invalid PNG filter ${filter}`);
      }
      rows[dst + x] = value & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  const pixels = width * height;
  for (let i = 0; i < pixels; i++) {
    const s = i * samples;
    const d = i * 4;
    switch (colorType) {
      case 6:
        data[d] = rows[s]!;
        data[d + 1] = rows[s + 1]!;
        data[d + 2] = rows[s + 2]!;
        data[d + 3] = rows[s + 3]!;
        break;
      case 2:
        data[d] = rows[s]!;
        data[d + 1] = rows[s + 1]!;
        data[d + 2] = rows[s + 2]!;
        data[d + 3] = 255;
        break;
      case 0:
        data[d] = data[d + 1] = data[d + 2] = rows[s]!;
        data[d + 3] = 255;
        break;
      case 4:
        data[d] = data[d + 1] = data[d + 2] = rows[s]!;
        data[d + 3] = rows[s + 1]!;
        break;
      default: {
        const index = rows[s]!;
        data[d] = palette![index * 3]!;
        data[d + 1] = palette![index * 3 + 1]!;
        data[d + 2] = palette![index * 3 + 2]!;
        data[d + 3] = transparency && index < transparency.length ? transparency[index]! : 255;
      }
    }
  }
  return { width, height, channels: 4, data, iccProfile: icc };
}

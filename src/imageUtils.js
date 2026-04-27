/**
 * Rotate a source canvas by a multiple of 90 degrees and return a new canvas.
 * direction: 'cw' | 'ccw'
 */
export function rotate90(src, direction) {
  const w = src.width;
  const h = src.height;
  const out = document.createElement('canvas');
  out.width = h;
  out.height = w;
  const ctx = out.getContext('2d');
  if (direction === 'cw') {
    ctx.translate(h, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, w);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(src, 0, 0);
  return out;
}

/**
 * Scale a source canvas uniformly by the given factor (aspect-ratio preserving).
 * Uses high-quality bilinear scaling.
 */
export function scaleUniform(src, factor) {
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(src.width * factor));
  out.height = Math.max(1, Math.round(src.height * factor));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/**
 * Convert the given canvas to a thresholded monochrome (black/white) canvas.
 * Pixels with luminance below `threshold` become black, others become white.
 */
export function toMonochrome(src, threshold = 180) {
  const w = src.width;
  const h = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) {
    // Rec. 601 luminance
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const v = y < threshold ? 0 : 255;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Convert a canvas to `{ color }` on transparent: pixels whose luminance is
 * below `threshold` become opaque with the given RGB color, all others become
 * fully transparent. Used for the preview overlay so that alignment of the
 * two halves can be visually verified.
 */
export function toColoredOnTransparent(src, threshold = 180, rgb = [0, 0, 0]) {
  const w = src.width;
  const h = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  const [r, g, b] = rgb;
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    if (y < threshold) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    } else {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

/**
 * Convert canvas -> ArrayBuffer of JPEG bytes.
 */
export async function canvasToJpegBytes(canvas, quality = 0.85) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Convert canvas -> ArrayBuffer of PNG bytes.
 */
export async function canvasToPngBytes(canvas) {
  const blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Encode a binary monochrome canvas (every pixel is either pure black or pure
 * white) as a 1-bit grayscale PNG. This is dramatically smaller than the JPEG
 * or 32-bit-RGBA PNG that the browser's `canvas.toBlob()` would produce: the
 * raw stream is 1 bit per pixel and Flate compresses runs of identical bits
 * very efficiently for line drawings.
 */
export async function monoCanvasToPngBytes(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, w, h);

  // Pack pixels as 1 bit per pixel, row-aligned to whole bytes (PNG spec).
  const rowBytes = Math.ceil(w / 8);
  const raw = new Uint8Array((rowBytes + 1) * h); // +1 for filter byte/row
  for (let y = 0; y < h; y++) {
    let p = y * (rowBytes + 1);
    raw[p++] = 0; // filter: None
    let bitBuf = 0;
    let bitCount = 0;
    for (let x = 0; x < w; x++) {
      // Source is binarized; treat the red channel as the value.
      // 1 = white, 0 = black (PNG color type 0 is white-on-light when read).
      const v = data[(y * w + x) * 4] >= 128 ? 1 : 0;
      bitBuf = (bitBuf << 1) | v;
      bitCount += 1;
      if (bitCount === 8) {
        raw[p++] = bitBuf;
        bitBuf = 0;
        bitCount = 0;
      }
    }
    if (bitCount > 0) {
      raw[p] = bitBuf << (8 - bitCount);
    }
  }

  const compressed = await deflateRaw(raw);

  return buildPng({
    width: w,
    height: h,
    bitDepth: 1,
    colorType: 0, // grayscale
    idat: compressed,
  });
}

// --------------------------------------------- PNG building helpers ---

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes) {
  // CompressionStream('deflate') yields zlib-wrapped output as required by PNG.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
}

function buildPng({ width, height, bitDepth, colorType, idat }) {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const chunks = [
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = sig.length + chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let off = sig.length;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function chunk(type, data) {
  const out = new Uint8Array(8 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcBuf = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) crcBuf[i] = type.charCodeAt(i);
  crcBuf.set(data, 4);
  dv.setUint32(8 + data.length, crc32(crcBuf));
  return out;
}

/**
 * Draw a circle + number "stamp" on the given context at (x, y) with diameter `d`.
 * (x, y) is the center of the circle.
 */
export function drawStamp(ctx, x, y, d, label, color = '#111') {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1, d * 0.06);
  ctx.beginPath();
  ctx.arc(x, y, d / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = `bold ${Math.round(d * 0.65)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y + d * 0.03);
  ctx.restore();
}

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
 * white) as Flate-compressed 1-bit-per-pixel samples, ready to be embedded
 * directly as a PDF `/DeviceGray /BitsPerComponent 1` image XObject.
 *
 * This must bypass pdf-lib's `embedPng`: that decodes the PNG and re-embeds it
 * as 8-bit RGB, which threw away the 1-bit encoding and made monochrome pages
 * ~2x larger than necessary.
 */
export async function monoCanvasToFlateBits(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, w, h);

  // Pack pixels as 1 bit per pixel, rows padded to whole bytes (PDF spec).
  // In DeviceGray at 1 bpc, 0 = black and 1 = white.
  const rowBytes = Math.ceil(w / 8);
  const raw = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    let p = y * rowBytes;
    let bitBuf = 0;
    let bitCount = 0;
    for (let x = 0; x < w; x++) {
      // Source is binarized; treat the red channel as the value.
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

  return { width: w, height: h, bytes: await deflate(raw) };
}

async function deflate(bytes) {
  // CompressionStream('deflate') yields zlib-wrapped output, which is what
  // PDF's FlateDecode filter expects.
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const ab = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(ab);
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

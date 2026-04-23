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

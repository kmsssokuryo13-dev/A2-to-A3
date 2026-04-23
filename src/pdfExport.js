import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import {
  A3_H_PT,
  A3_W_PT,
  COLOR_JPEG_QUALITY,
  MONO_JPEG_QUALITY,
  DEFAULT_MONO_THRESHOLD,
} from './constants.js';
import {
  canvasToJpegBytes,
  toMonochrome,
} from './imageUtils.js';
import { composePair, getJoinX } from './compose.js';

/**
 * Build the combined A3 landscape "Page 1" canvas for a pair.
 * Adds the drawing name label, the red join line, and ①/② stamps.
 */
function buildCombinedPageCanvas(pair, { monochrome, monoThreshold }) {
  const { leftA4, rightA4, alignment, drawingName } = pair;

  // 1) Composite the two halves.
  let composite = composePair(leftA4, rightA4, alignment);

  // 2) Monochrome preprocessing (reduces file size and keeps drawings crisp).
  if (monochrome) {
    composite = toMonochrome(composite, monoThreshold);
  }

  // 3) Draw overlay: drawing-name label, red join line, ①② stamps.
  const overlay = document.createElement('canvas');
  overlay.width = composite.width;
  overlay.height = composite.height;
  const ctx = overlay.getContext('2d');
  ctx.drawImage(composite, 0, 0);

  // Drawing name (top-left, with "全体" suffix)
  if (drawingName) {
    const label = `${drawingName}全体`;
    const fontSize = Math.max(24, Math.round(overlay.height * 0.032));
    ctx.font = `bold ${fontSize}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillStyle = '#fff';
    // Paint a white backdrop so the label is always legible on busy drawings.
    const metrics = ctx.measureText(label);
    const padX = fontSize * 0.4;
    const padY = fontSize * 0.2;
    const bx = Math.round(overlay.width * 0.015);
    const by = Math.round(overlay.height * 0.015);
    ctx.fillRect(
      bx - padX,
      by - padY,
      metrics.width + padX * 2,
      fontSize + padY * 2,
    );
    ctx.fillStyle = '#111';
    ctx.fillText(label, bx, by);
  }

  // Red join line (thin, semi-transparent)
  const joinX = getJoinX(leftA4, alignment);
  ctx.save();
  ctx.strokeStyle = 'rgba(220, 0, 0, 0.5)';
  ctx.lineWidth = Math.max(0.8, overlay.height * 0.0008);
  ctx.beginPath();
  ctx.moveTo(joinX, 0);
  ctx.lineTo(joinX, overlay.height);
  ctx.stroke();
  ctx.restore();

  // ①/② stamps — bottom-left of each half (2/3 baseline font size).
  const stampDiam = Math.round(overlay.height * 0.05);
  drawStamp(
    ctx,
    Math.round(overlay.width * 0.02) + stampDiam / 2,
    overlay.height - Math.round(overlay.height * 0.03) - stampDiam / 2,
    stampDiam,
    '①',
  );
  drawStamp(
    ctx,
    Math.round(joinX + overlay.width * 0.012) + stampDiam / 2,
    overlay.height - Math.round(overlay.height * 0.03) - stampDiam / 2,
    stampDiam,
    '②',
  );

  return overlay;
}

function drawStamp(ctx, cx, cy, diam, label) {
  const r = diam / 2;
  ctx.save();
  ctx.lineWidth = Math.max(1, diam * 0.06);
  ctx.strokeStyle = '#111';
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.font = `bold ${Math.round(diam * 0.7)}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy + diam * 0.02);
  ctx.restore();
}

/**
 * Build the "Page 2"/"Page 3" canvas — the original half-scan with a single
 * ①/② stamp in the bottom-left.
 */
function buildSinglePageCanvas(sourceCanvas, stampLabel, { monochrome, monoThreshold }) {
  let src = sourceCanvas;
  if (monochrome) src = toMonochrome(src, monoThreshold);

  const out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext('2d');
  ctx.drawImage(src, 0, 0);

  const stampDiam = Math.round(Math.min(out.width, out.height) * 0.04);
  drawStamp(
    ctx,
    Math.round(out.width * 0.03) + stampDiam / 2,
    out.height - Math.round(out.height * 0.03) - stampDiam / 2,
    stampDiam,
    stampLabel,
  );
  return out;
}

/**
 * Fit `(imgW, imgH)` into `(pageW, pageH)` preserving aspect, centered.
 * Returns { x, y, w, h } in page units.
 */
function fitContain(imgW, imgH, pageW, pageH, marginPt = 0) {
  const innerW = pageW - marginPt * 2;
  const innerH = pageH - marginPt * 2;
  const s = Math.min(innerW / imgW, innerH / imgH);
  const w = imgW * s;
  const h = imgH * s;
  return {
    x: (pageW - w) / 2,
    y: (pageH - h) / 2,
    w,
    h,
  };
}

/**
 * Export the given pairs to a multi-page PDF (3 pages per pair).
 *
 * @param {Array} pairs
 * @param {object} options
 * @param {boolean} options.monochrome
 * @param {number} [options.monoThreshold]
 * @param {string} [options.fileBaseName]  Used for the output filename.
 */
export async function exportToPdf(pairs, options) {
  const {
    monochrome = true,
    monoThreshold = DEFAULT_MONO_THRESHOLD,
    fileBaseName = 'output',
  } = options;

  const quality = monochrome ? MONO_JPEG_QUALITY : COLOR_JPEG_QUALITY;

  const doc = await PDFDocument.create();

  for (const pair of pairs) {
    // ---- Page 1: combined (A3 landscape) ----
    const combined = buildCombinedPageCanvas(pair, { monochrome, monoThreshold });
    const combinedBytes = await canvasToJpegBytes(combined, quality);
    const combinedImg = await doc.embedJpg(combinedBytes);
    const p1 = doc.addPage([A3_H_PT, A3_W_PT]); // A3 landscape
    {
      const box = fitContain(combined.width, combined.height, A3_H_PT, A3_W_PT, 10);
      p1.drawImage(combinedImg, { x: box.x, y: box.y, width: box.w, height: box.h });
    }

    // ---- Page 2: left half (A3 portrait) with ① ----
    const leftPage = buildSinglePageCanvas(
      pair.leftOriginal,
      '①',
      { monochrome, monoThreshold },
    );
    const leftBytes = await canvasToJpegBytes(leftPage, quality);
    const leftImg = await doc.embedJpg(leftBytes);
    const p2 = doc.addPage([A3_W_PT, A3_H_PT]); // A3 portrait
    {
      const box = fitContain(leftPage.width, leftPage.height, A3_W_PT, A3_H_PT, 10);
      p2.drawImage(leftImg, { x: box.x, y: box.y, width: box.w, height: box.h });
    }

    // ---- Page 3: right half (A3 portrait) with ② ----
    const rightPage = buildSinglePageCanvas(
      pair.rightOriginal,
      '②',
      { monochrome, monoThreshold },
    );
    const rightBytes = await canvasToJpegBytes(rightPage, quality);
    const rightImg = await doc.embedJpg(rightBytes);
    const p3 = doc.addPage([A3_W_PT, A3_H_PT]); // A3 portrait
    {
      const box = fitContain(rightPage.width, rightPage.height, A3_W_PT, A3_H_PT, 10);
      p3.drawImage(rightImg, { x: box.x, y: box.y, width: box.w, height: box.h });
    }
  }

  const bytes = await doc.save();
  return {
    bytes,
    filename: `${fileBaseName}全体.pdf`,
  };
}

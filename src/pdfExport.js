import { PDFDocument } from 'pdf-lib';
import {
  A3_H_PT,
  A3_W_PT,
  COLOR_JPEG_QUALITY,
  DEFAULT_MONO_THRESHOLD,
} from './constants.js';
import {
  canvasToJpegBytes,
  canvasToPngBytes,
  monoCanvasToPngBytes,
  rotate90,
  toMonochrome,
} from './imageUtils.js';
import { composePair, getJoinX } from './compose.js';

// Color of the join line and the ①/② stamps (slightly translucent so the
// drawing underneath is still visible through the line).
const ACCENT_RED = 'rgba(220, 0, 0, 0.7)';

/**
 * Build the bare A3-landscape "Page 1" drawing canvas (no decorations baked in).
 * Decorations (label / red join line / ①② stamps) are drawn on a separate
 * transparent overlay so the drawing itself can be encoded as a tiny 1-bit PNG
 * while keeping the colored decorations in full color.
 */
function buildCombinedDrawingCanvas(pair, { monochrome, monoThreshold }) {
  const { leftA4, rightA4, alignment } = pair;
  const composite = composePair(leftA4, rightA4, alignment);
  return monochrome ? toMonochrome(composite, monoThreshold) : composite;
}

/**
 * Build the transparent decorations overlay for the combined page: drawing-name
 * label (with white backdrop), red join line, and ①/② circled-digit stamps.
 * The canvas is the same size as the drawing canvas so it can be drawn as a
 * separate image at the same position in the PDF.
 */
function buildCombinedDecorationsCanvas(pair, sizeRef) {
  const { leftA4, alignment, drawingName } = pair;
  const out = document.createElement('canvas');
  out.width = sizeRef.width;
  out.height = sizeRef.height;
  const ctx = out.getContext('2d');

  // Drawing name label (top-left, with "全体" suffix). Painted over a white
  // backdrop so it remains legible regardless of what's underneath.
  if (drawingName) {
    const label = `${drawingName}全体`;
    const fontSize = Math.max(24, Math.round(out.height * 0.032));
    ctx.font = `bold ${fontSize}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const metrics = ctx.measureText(label);
    const padX = fontSize * 0.4;
    const padY = fontSize * 0.2;
    const bx = Math.round(out.width * 0.015);
    const by = Math.round(out.height * 0.015);
    ctx.fillStyle = '#fff';
    ctx.fillRect(
      bx - padX,
      by - padY,
      metrics.width + padX * 2,
      fontSize + padY * 2,
    );
    ctx.fillStyle = '#111';
    ctx.fillText(label, bx, by);
  }

  // Red join line at the right-half's left edge.
  const joinX = getJoinX(leftA4, alignment);
  ctx.save();
  ctx.strokeStyle = ACCENT_RED;
  ctx.lineWidth = Math.max(0.8, out.height * 0.0008);
  ctx.beginPath();
  ctx.moveTo(joinX, 0);
  ctx.lineTo(joinX, out.height);
  ctx.stroke();
  ctx.restore();

  // ①/② stamps — bottom-left of each half. The Unicode characters already
  // include their own circle, so no outer ring is drawn (was double-circled).
  const stampDiam = Math.round(out.height * 0.05);
  drawCircledDigit(
    ctx,
    Math.round(out.width * 0.02) + stampDiam / 2,
    out.height - Math.round(out.height * 0.03) - stampDiam / 2,
    stampDiam,
    '①',
  );
  drawCircledDigit(
    ctx,
    Math.round(joinX + out.width * 0.012) + stampDiam / 2,
    out.height - Math.round(out.height * 0.03) - stampDiam / 2,
    stampDiam,
    '②',
  );

  return out;
}

/**
 * Draw a circled-digit (e.g. ①, ②) glyph centered at (cx, cy). The Unicode
 * character itself includes the surrounding circle, so we draw only the glyph.
 */
function drawCircledDigit(ctx, cx, cy, diam, label) {
  ctx.save();
  ctx.fillStyle = ACCENT_RED;
  // The glyph fills almost the full diameter; use a font slightly larger than
  // the bounding box so the circle reads as the same size as before.
  ctx.font = `${Math.round(diam * 1.15)}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
  ctx.restore();
}

/**
 * Build the bare single-page drawing canvas (the original half-scan,
 * optionally monochromized). The single ①/② stamp is drawn on a separate
 * decorations overlay (see `buildSinglePageDecorationsCanvas`).
 */
function buildSinglePageDrawingCanvas(sourceCanvas, { monochrome, monoThreshold }) {
  return monochrome ? toMonochrome(sourceCanvas, monoThreshold) : sourceCanvas;
}

function buildSinglePageDecorationsCanvas(stampLabel, sizeRef) {
  const out = document.createElement('canvas');
  out.width = sizeRef.width;
  out.height = sizeRef.height;
  const ctx = out.getContext('2d');
  const stampDiam = Math.round(Math.min(out.width, out.height) * 0.04);
  drawCircledDigit(
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

  const doc = await PDFDocument.create();

  // Embed the bare drawing as either a 1-bit grayscale PNG (binary monochrome
  // content compresses dramatically smaller than JPEG) or a JPEG (continuous-
  // tone). Decorations always go through `embedDecorations` as RGBA PNG.
  const embedDrawing = async (canvas) => {
    if (monochrome) {
      const bytes = await monoCanvasToPngBytes(canvas);
      return doc.embedPng(bytes);
    }
    const bytes = await canvasToJpegBytes(canvas, COLOR_JPEG_QUALITY);
    return doc.embedJpg(bytes);
  };
  const embedDecorations = async (canvas) => {
    const bytes = await canvasToPngBytes(canvas);
    return doc.embedPng(bytes);
  };

  for (const pair of pairs) {
    // ---- Page 1: combined (A3 landscape) ----
    const combined = buildCombinedDrawingCanvas(pair, { monochrome, monoThreshold });
    const combinedDecor = buildCombinedDecorationsCanvas(pair, combined);
    const combinedImg = await embedDrawing(combined);
    const combinedDecorImg = await embedDecorations(combinedDecor);
    const p1 = doc.addPage([A3_H_PT, A3_W_PT]); // A3 landscape
    {
      const box = fitContain(combined.width, combined.height, A3_H_PT, A3_W_PT, 0);
      p1.drawImage(combinedImg, { x: box.x, y: box.y, width: box.w, height: box.h });
      p1.drawImage(combinedDecorImg, { x: box.x, y: box.y, width: box.w, height: box.h });
    }

    // ---- Page 2: left half rotated 90° CCW, with ① ----
    const leftRotated = rotate90(pair.leftOriginal, 'ccw');
    const leftDrawing = buildSinglePageDrawingCanvas(leftRotated, { monochrome, monoThreshold });
    const leftDecor = buildSinglePageDecorationsCanvas('①', leftDrawing);
    const leftImg = await embedDrawing(leftDrawing);
    const leftDecorImg = await embedDecorations(leftDecor);
    {
      // After a 90° rotation the source's width/height pt dimensions swap.
      const srcW = pair.leftOriginalPt?.width ?? A3_W_PT;
      const srcH = pair.leftOriginalPt?.height ?? A3_H_PT;
      const pw = srcH;
      const ph = srcW;
      const p2 = doc.addPage([pw, ph]);
      p2.drawImage(leftImg, { x: 0, y: 0, width: pw, height: ph });
      p2.drawImage(leftDecorImg, { x: 0, y: 0, width: pw, height: ph });
    }

    // ---- Page 3: right half rotated 90° CW, with ② ----
    const rightRotated = rotate90(pair.rightOriginal, 'cw');
    const rightDrawing = buildSinglePageDrawingCanvas(rightRotated, { monochrome, monoThreshold });
    const rightDecor = buildSinglePageDecorationsCanvas('②', rightDrawing);
    const rightImg = await embedDrawing(rightDrawing);
    const rightDecorImg = await embedDecorations(rightDecor);
    {
      const srcW = pair.rightOriginalPt?.width ?? A3_W_PT;
      const srcH = pair.rightOriginalPt?.height ?? A3_H_PT;
      const pw = srcH;
      const ph = srcW;
      const p3 = doc.addPage([pw, ph]);
      p3.drawImage(rightImg, { x: 0, y: 0, width: pw, height: ph });
      p3.drawImage(rightDecorImg, { x: 0, y: 0, width: pw, height: ph });
    }
  }

  const bytes = await doc.save();
  return {
    bytes,
    filename: `${fileBaseName}全体.pdf`,
  };
}

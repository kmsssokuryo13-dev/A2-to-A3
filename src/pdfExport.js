import {
  PDFDocument,
  PDFName,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from 'pdf-lib';
import {
  A3_H_PT,
  A3_W_PT,
  COLOR_JPEG_QUALITY,
  DEFAULT_MONO_THRESHOLD,
  PX_PER_MM,
} from './constants.js';
import {
  canvasToJpegBytes,
  canvasToPngBytes,
  monoCanvasToFlateBits,
  rotate90,
  toMonochrome,
} from './imageUtils.js';
import { composePair, getJoinX } from './compose.js';
import {
  drawCombined,
  drawSingleHalf,
  hasColorPixels,
  isBilevelScanPage,
} from './pdfPassthrough.js';

// Color of the join line and the ①/② stamps (slightly translucent so the
// drawing underneath is still visible through the line).
const ACCENT_RED = 'rgba(220, 0, 0, 0.7)';
const ACCENT_RED_PDF = { color: rgb(220 / 255, 0, 0), opacity: 0.7 };

/**
 * Build the bare A3-landscape "Page 1" drawing canvas (no decorations baked in).
 * Decorations (label / red join line / ①② stamps) are added separately (see
 * `buildCombinedDecorations`) so the drawing itself can be encoded as a tiny
 * 1-bit image while keeping the colored decorations in full color.
 *
 * In monochrome mode the halves are composed from the unscaled A3 originals
 * instead of the A4-scaled preview canvases. The combined page is then ~√2x
 * sharper (≈310 dpi on A3 instead of ≈155 dpi), which keeps small text
 * legible; previously the A2→A3 downscale blurred strokes to gray and the
 * threshold filled in the gaps inside characters. The 1-bit encoding keeps
 * the extra pixels cheap. Color mode keeps the A4 resolution because its
 * JPEG size grows with pixel count.
 *
 * Returns `{ canvas, pxPerMm }` where `pxPerMm` is the canvas resolution in
 * alignment-mm (needed to place the join line).
 */
function buildCombinedDrawingCanvas(pair, { monochrome, monoThreshold }) {
  const { leftA4, rightA4, alignment } = pair;
  if (!monochrome) {
    return { canvas: composePair(leftA4, rightA4, alignment), pxPerMm: PX_PER_MM };
  }
  const left = rotate90(pair.leftOriginal, 'ccw');
  const right = rotate90(pair.rightOriginal, 'cw');
  // Exact ratio between the original and the A4-scaled canvas (≈√2).
  const pxPerMm = PX_PER_MM * (left.width / leftA4.width);
  const composite = composePair(left, right, alignment, pxPerMm);
  return { canvas: toMonochrome(composite, monoThreshold), pxPerMm };
}

/**
 * Render `text` into a tight transparent canvas. Returns the canvas plus the
 * offset of the text's anchor point inside it, so callers can position it.
 */
function renderTextCanvas(text, font, anchor) {
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  // Bounding-box metrics are relative to the anchor, so measure with the
  // same alignment the text is drawn with.
  measure.textAlign = anchor.textAlign;
  measure.textBaseline = anchor.textBaseline;
  const m = measure.measureText(text);
  const left = Math.ceil(m.actualBoundingBoxLeft ?? 0) + 2;
  const right = Math.ceil(m.actualBoundingBoxRight ?? m.width) + 2;
  const ascent = Math.ceil(m.actualBoundingBoxAscent ?? 0) + 2;
  const descent = Math.ceil(m.actualBoundingBoxDescent ?? 0) + 2;
  const out = document.createElement('canvas');
  out.width = Math.max(1, left + right);
  out.height = Math.max(1, ascent + descent);
  const ctx = out.getContext('2d');
  ctx.font = font;
  ctx.textAlign = anchor.textAlign;
  ctx.textBaseline = anchor.textBaseline;
  ctx.fillStyle = ACCENT_RED;
  ctx.fillText(text, left, ascent);
  return { canvas: out, anchorX: left, anchorY: ascent };
}

/**
 * Draw `text` so that its anchor point is at (x, y) in drawing pixels.
 * Returns a decoration item `{ canvas, x, y }` (top-left in drawing pixels).
 */
function textItem(text, font, x, y, anchor) {
  const t = renderTextCanvas(text, font, anchor);
  return { canvas: t.canvas, x: x - t.anchorX, y: y - t.anchorY };
}

/**
 * A circled-digit (e.g. ①, ②) glyph centered at (cx, cy). The Unicode
 * character itself includes the surrounding circle, so we draw only the glyph.
 * The glyph fills almost the full diameter; use a font slightly larger than
 * the bounding box so the circle reads as the same size as before.
 */
function circledDigitItem(cx, cy, diam, label) {
  const font = `${Math.round(diam * 1.15)}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif`;
  return textItem(label, font, cx, cy, { textAlign: 'center', textBaseline: 'middle' });
}

/**
 * Decorations for the combined page: drawing-name label (red text, no
 * backdrop), red join line, and ①/② circled-digit stamps. Text items are
 * small, tightly cropped images; the join line is drawn as a PDF vector line.
 * Previously all decorations were one full-page RGBA image, which cost
 * ~60 KB per page even though it was almost entirely transparent.
 */
function buildCombinedDecorations(pair, size, pxPerMm) {
  const { leftA4, alignment, drawingName } = pair;
  const items = [];

  // Drawing name label (top-left, with "全体" suffix).
  if (drawingName) {
    const fontSize = Math.max(24, Math.round(size.height * 0.032));
    const font = `bold ${fontSize}px "Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif`;
    items.push(
      textItem(
        `${drawingName}全体`,
        font,
        Math.round(size.width * 0.015),
        Math.round(size.height * 0.015),
        { textAlign: 'left', textBaseline: 'top' },
      ),
    );
  }

  // Red join line at the right-half's left edge.
  const joinX = getJoinX(leftA4, alignment) * (pxPerMm / PX_PER_MM);
  const line = { x: joinX, width: Math.max(0.8, size.height * 0.0008) };

  // ①/② stamps — bottom-left of each half.
  const stampDiam = Math.round(size.height * 0.05);
  const stampY = size.height - Math.round(size.height * 0.03) - stampDiam / 2;
  items.push(
    circledDigitItem(Math.round(size.width * 0.02) + stampDiam / 2, stampY, stampDiam, '①'),
    circledDigitItem(Math.round(joinX + size.width * 0.012) + stampDiam / 2, stampY, stampDiam, '②'),
  );

  return { items, line };
}

/**
 * Build the bare single-page drawing canvas (the original half-scan,
 * optionally monochromized). The single ①/② stamp is added separately (see
 * `buildSinglePageDecorations`).
 */
function buildSinglePageDrawingCanvas(sourceCanvas, { monochrome, monoThreshold }) {
  return monochrome ? toMonochrome(sourceCanvas, monoThreshold) : sourceCanvas;
}

function buildSinglePageDecorations(stampLabel, size) {
  const stampDiam = Math.round(Math.min(size.width, size.height) * 0.04);
  return {
    items: [
      circledDigitItem(
        Math.round(size.width * 0.03) + stampDiam / 2,
        size.height - Math.round(size.height * 0.03) - stampDiam / 2,
        stampDiam,
        stampLabel,
      ),
    ],
    line: null,
  };
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
    sourceBytes = null,
    fileBaseName = 'output',
  } = options;

  const doc = await PDFDocument.create();

  // Pages that are already bi-level scans are embedded as-is (see
  // pdfPassthrough.js); everything else is rasterized below.
  const srcDoc =
    monochrome && sourceBytes ? await PDFDocument.load(sourceBytes, { ignoreEncryption: true }) : null;
  const embeddedPages = new Map();
  const passthroughHalf = async (pageIndex, side, displayPt) => {
    if (!embeddedPages.has(pageIndex)) {
      const srcPage = srcDoc.getPage(pageIndex);
      const box = srcPage.getCropBox();
      embeddedPages.set(pageIndex, {
        embedded: await doc.embedPage(srcPage, {
          left: box.x,
          bottom: box.y,
          right: box.x + box.width,
          top: box.y + box.height,
        }),
        rotation: srcPage.getRotation().angle,
      });
    }
    return { ...embeddedPages.get(pageIndex), side, displayPt };
  };
  const canPassthrough = (pageIndex, canvas) =>
    srcDoc != null &&
    pageIndex != null &&
    pageIndex < srcDoc.getPageCount() &&
    isBilevelScanPage(srcDoc.getPage(pageIndex)) &&
    !hasColorPixels(canvas);

  // Draw the bare drawing filling `box` (page points). Monochrome drawings are
  // embedded as raw 1-bit DeviceGray image XObjects (Flate); color drawings as
  // JPEG.
  const drawDrawing = async (page, canvas, box) => {
    if (!monochrome) {
      const img = await doc.embedJpg(await canvasToJpegBytes(canvas, COLOR_JPEG_QUALITY));
      page.drawImage(img, { x: box.x, y: box.y, width: box.w, height: box.h });
      return;
    }
    const { width, height, bytes } = await monoCanvasToFlateBits(canvas);
    const ref = doc.context.register(
      doc.context.stream(bytes, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: width,
        Height: height,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 1,
        Filter: 'FlateDecode',
      }),
    );
    const name = page.node.newXObject('Image', ref);
    page.pushOperators(
      pushGraphicsState(),
      concatTransformationMatrix(box.w, 0, 0, box.h, box.x, box.y),
      drawObject(name),
      popGraphicsState(),
    );
  };

  // Draw decorations over a drawing of `size` (pixels) placed at `box`.
  const drawDecorations = async (page, { items, line }, size, box) => {
    const k = box.w / size.width;
    for (const item of items) {
      const img = await doc.embedPng(await canvasToPngBytes(item.canvas));
      const w = item.canvas.width * k;
      const h = item.canvas.height * k;
      page.drawImage(img, {
        x: box.x + item.x * k,
        y: box.y + box.h - item.y * k - h,
        width: w,
        height: h,
      });
    }
    if (line) {
      const x = box.x + line.x * k;
      page.drawLine({
        start: { x, y: box.y },
        end: { x, y: box.y + box.h },
        thickness: line.width * k,
        ...ACCENT_RED_PDF,
      });
    }
  };

  for (const pair of pairs) {
    if (
      canPassthrough(pair.leftPageIndex, pair.leftOriginal) &&
      canPassthrough(pair.rightPageIndex, pair.rightOriginal)
    ) {
      await exportPairPassthrough(doc, pair, {
        left: await passthroughHalf(pair.leftPageIndex, 'left', pair.leftOriginalPt),
        right: await passthroughHalf(pair.rightPageIndex, 'right', pair.rightOriginalPt),
        drawDecorations,
      });
      continue;
    }

    // ---- Page 1: combined (A3 landscape) ----
    const { canvas: combined, pxPerMm } = buildCombinedDrawingCanvas(pair, {
      monochrome,
      monoThreshold,
    });
    const p1 = doc.addPage([A3_H_PT, A3_W_PT]); // A3 landscape
    {
      const box = fitContain(combined.width, combined.height, A3_H_PT, A3_W_PT, 0);
      await drawDrawing(p1, combined, box);
      await drawDecorations(p1, buildCombinedDecorations(pair, combined, pxPerMm), combined, box);
    }

    // ---- Page 2: left half rotated 90° CCW, with ① ----
    // ---- Page 3: right half rotated 90° CW, with ② ----
    const halves = [
      { source: pair.leftOriginal, pt: pair.leftOriginalPt, dir: 'ccw', label: '①' },
      { source: pair.rightOriginal, pt: pair.rightOriginalPt, dir: 'cw', label: '②' },
    ];
    for (const half of halves) {
      const rotated = rotate90(half.source, half.dir);
      const drawing = buildSinglePageDrawingCanvas(rotated, { monochrome, monoThreshold });
      // After a 90° rotation the source's width/height pt dimensions swap.
      const pw = half.pt?.height ?? A3_H_PT;
      const ph = half.pt?.width ?? A3_W_PT;
      const page = doc.addPage([pw, ph]);
      const box = { x: 0, y: 0, w: pw, h: ph };
      await drawDrawing(page, drawing, box);
      await drawDecorations(page, buildSinglePageDecorations(half.label, drawing), drawing, box);
    }
  }

  const bytes = await doc.save();
  return {
    bytes,
    filename: `${fileBaseName}全体.pdf`,
  };
}

/**
 * Export one pair by placing the original (bi-level) source pages instead of
 * re-rasterized canvases. Geometry and decorations match the raster path.
 */
async function exportPairPassthrough(doc, pair, { left, right, drawDecorations }) {
  const { leftA4, rightA4, alignment } = pair;

  // ---- Page 1: combined (A3 landscape) ----
  // Composite size in A4-scaled pixels, same as composePair().
  const joinX = getJoinX(leftA4, alignment);
  const comp = {
    width: Math.round(joinX + rightA4.width),
    height: Math.max(leftA4.height, rightA4.height),
  };
  const p1 = doc.addPage([A3_H_PT, A3_W_PT]);
  const box = fitContain(comp.width, comp.height, A3_H_PT, A3_W_PT, 0);
  drawCombined(p1, pair, left, right, box, comp);
  await drawDecorations(p1, buildCombinedDecorations(pair, comp, PX_PER_MM), comp, box);

  // ---- Pages 2 and 3: each half upright, with ① / ② ----
  for (const [half, source, label] of [
    [left, pair.leftOriginal, '①'],
    [right, pair.rightOriginal, '②'],
  ]) {
    // After a 90° rotation the source's width/height swap.
    const pw = half.displayPt?.height ?? A3_H_PT;
    const ph = half.displayPt?.width ?? A3_W_PT;
    const page = doc.addPage([pw, ph]);
    drawSingleHalf(page, half);
    // Decorations are laid out in the 220 dpi raster's pixel space so the
    // stamp renders at the same size and sharpness as before.
    const size = { width: source.height, height: source.width };
    await drawDecorations(page, buildSinglePageDecorations(label, size), size, {
      x: 0,
      y: 0,
      w: pw,
      h: ph,
    });
  }
}

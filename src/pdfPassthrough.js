/**
 * Helpers for embedding the uploaded PDF's pages directly into the output
 * instead of re-rasterizing them.
 *
 * Scanned drawings are usually 300 dpi 1-bit (CCITT) images. Rendering them at
 * 220 dpi, re-thresholding and re-encoding loses detail (small text fills in)
 * and makes the output ~3x larger than the input. When a page is a plain
 * bi-level scan, the export instead places the original page as a Form
 * XObject with an affine transform, which keeps the scan's exact pixels and
 * re-uses the same compressed data on every output page that shows it.
 */

import {
  PDFName,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
} from 'pdf-lib';
import { MAX_OVERLAP_MM, PX_PER_MM } from './constants.js';

// -----------------------------------------------------------------------------
// Eligibility
// -----------------------------------------------------------------------------

/**
 * True when every image XObject used by the page (including inside Form
 * XObjects) is 1-bit (or an image mask), and there is at least one image.
 * Such a page is already monochrome, so thresholding it would only degrade it.
 */
export function isBilevelScanPage(srcPage) {
  const resources = srcPage.node.Resources();
  if (!resources) return false;
  const state = { images: 0, ok: true };
  collectImages(srcPage.doc.context, resources, state, new Set());
  return state.ok && state.images > 0;
}

function collectImages(context, resources, state, seen) {
  const xobjects = context.lookup(resources.get(name('XObject')));
  if (!xobjects || typeof xobjects.entries !== 'function') return;
  for (const [, ref] of xobjects.entries()) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const stream = context.lookup(ref);
    const dict = stream?.dict;
    if (!dict) continue;
    const subtype = dict.get(name('Subtype'))?.toString();
    if (subtype === '/Image') {
      state.images += 1;
      const isMask = dict.get(name('ImageMask'))?.toString() === 'true';
      const bpc = context.lookup(dict.get(name('BitsPerComponent')))?.asNumber?.();
      if (!isMask && bpc !== 1) state.ok = false;
    } else if (subtype === '/Form') {
      const formResources = context.lookup(dict.get(name('Resources')));
      if (formResources) collectImages(context, formResources, state, seen);
    }
  }
}

function name(n) {
  return PDFName.of(n);
}

/**
 * True when the rendered page contains clearly colored pixels (e.g. red
 * vector annotations on top of the scan). Those pages still go through the
 * raster path so that the "モノクロ化" option is honored.
 */
export function hasColorPixels(canvas) {
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Sample every 3rd pixel; color is never a single isolated pixel.
  for (let i = 0; i < data.length; i += 12) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) > 48) return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Affine matrices, PDF convention [a b c d e f]:
//   x' = a·x + c·y + e,  y' = b·x + d·y + f
// `mul(A, B)` applies A first, then B.
// -----------------------------------------------------------------------------

function mul(A, B) {
  const [a1, b1, c1, d1, e1, f1] = A;
  const [a2, b2, c2, d2, e2, f2] = B;
  return [
    a1 * a2 + b1 * c2,
    a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2,
    c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2,
    e1 * b2 + f1 * d2 + f2,
  ];
}

/**
 * Map the embedded page's own coordinates (bounding-box adjusted, y up) to the
 * page as displayed (after its /Rotate, y up).
 */
function displayMatrix(embedded, rotation) {
  const w = embedded.width;
  const h = embedded.height;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return [0, -1, 1, 0, 0, w];
    case 180:
      return [-1, 0, 0, -1, w, h];
    case 270:
      return [0, 1, -1, 0, h, 0];
    default:
      return [1, 0, 0, 1, 0, 0];
  }
}

/**
 * Displayed page (width `dw`, height `dh` in pt, y up) → the upright half
 * canvas (y down) of size `outW`×`outH`, mirroring `rotate90()` + scaling.
 *   left half:  rotated 90° CCW
 *   right half: rotated 90° CW
 */
function uprightMatrix(side, dw, dh, outW, outH) {
  const sx = outW / dh;
  const sy = outH / dw;
  return side === 'left'
    ? [0, -sy, -sx, 0, sx * dh, sy * dw]
    : [0, sy, sx, 0, 0, 0];
}

/**
 * Draw `embedded` (a PDFEmbeddedPage) on `page` so that it appears exactly
 * like the raster pipeline would place the corresponding half canvas.
 *
 * @param {object} half  { embedded, rotation, displayPt:{width,height}, side }
 * @param {{w:number,h:number}} canvasSize  Size of the upright half canvas
 * @param {number[]} toCanvas  Extra transform within the target canvas (y down)
 * @param {number[]} canvasToPage  Canvas (y down) → page (pt, y up)
 */
function drawHalf(page, half, canvasSize, toCanvas, canvasToPage) {
  const m = [displayMatrix(half.embedded, half.rotation),
    uprightMatrix(half.side, half.displayPt.width, half.displayPt.height, canvasSize.w, canvasSize.h),
    toCanvas,
    canvasToPage].reduce(mul);
  const xobj = page.node.newXObject('EmbeddedPdfPage', half.embedded.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...m),
    drawObject(xobj),
    popGraphicsState(),
  );
}

const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * Draw a single upright half filling the whole `page` (pages 2 and 3).
 * The upright canvas is expressed directly in page points.
 */
export function drawSingleHalf(page, half) {
  const pw = page.getWidth();
  const ph = page.getHeight();
  drawHalf(page, half, { w: pw, h: ph }, IDENTITY, [1, 0, 0, -1, 0, ph]);
}

/**
 * Draw the combined page (page 1): left half fixed at the origin, right half
 * shifted by the overlap / vertical offset and rotated around its center, in
 * the same A4-scaled pixel space as `composePair()`. Everything is clipped to
 * `box`, the page-space rectangle the composite occupies.
 *
 * @param {object} pair     The app's pair (leftA4/rightA4/alignment)
 * @param {object} left     Half descriptor for the left page
 * @param {object} right    Half descriptor for the right page
 * @param {{x,y,w,h}} box   Composite placement on the page (pt)
 * @param {{width,height}} comp  Composite size (A4-scaled px)
 */
export function drawCombined(page, pair, left, right, box, comp) {
  const { leftA4, rightA4, alignment } = pair;
  const k = box.w / comp.width;
  const canvasToPage = [k, 0, 0, -k, box.x, box.y + box.h];

  page.pushOperators(
    pushGraphicsState(),
    rectangle(box.x, box.y, box.w, box.h),
    clip(),
    endPath(),
  );

  drawHalf(page, left, { w: leftA4.width, h: leftA4.height }, IDENTITY, canvasToPage);

  const overlapPx = Math.max(0, Math.min(MAX_OVERLAP_MM, alignment.overlapMm)) * PX_PER_MM;
  const tyPx = alignment.tyMm * PX_PER_MM;
  const t = (alignment.angleDeg * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const rw = rightA4.width;
  const rh = rightA4.height;
  const rx = leftA4.width - overlapPx + rw / 2;
  const ry = rh / 2 + tyPx;
  const place = [cos, sin, -sin, cos, rx - cos * (rw / 2) + sin * (rh / 2), ry - sin * (rw / 2) - cos * (rh / 2)];
  drawHalf(page, right, { w: rw, h: rh }, place, canvasToPage);

  page.pushOperators(popGraphicsState());
}

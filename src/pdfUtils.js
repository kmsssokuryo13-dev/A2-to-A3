import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

import { PX_PER_MM } from './constants.js';

/**
 * Load a PDF file (File or ArrayBuffer) and return pdf.js document.
 */
export async function loadPdf(input) {
  const data = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const task = pdfjsLib.getDocument({ data: new Uint8Array(data) });
  return task.promise;
}

/**
 * Render a PDF page to canvas. The canvas pixel dimensions are sized so that
 * the rendered page matches the target physical size at RENDER_DPI.
 *
 * pdf.js page viewport uses PDF points (72 DPI). To render at N DPI, use
 * scale = N / 72.
 */
export async function renderPageToCanvas(pdf, pageNumber, opts = {}) {
  const page = await pdf.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const dpi = opts.dpi ?? 220;
  const scale = dpi / 72;
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');

  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
  }).promise;

  return {
    canvas,
    widthPt: baseViewport.width,
    heightPt: baseViewport.height,
    widthMm: (baseViewport.width / 72) * 25.4,
    heightMm: (baseViewport.height / 72) * 25.4,
  };
}

/**
 * Derive a safe "base name" for output, stripping extension.
 */
export function stripExt(filename) {
  if (!filename) return 'output';
  const idx = filename.lastIndexOf('.');
  return idx > 0 ? filename.slice(0, idx) : filename;
}

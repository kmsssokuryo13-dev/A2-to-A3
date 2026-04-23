import { PX_PER_MM, MAX_OVERLAP_MM } from './constants.js';

/**
 * Compose left + right halves into a single canvas.
 *  - Left image is fixed at (0, 0).
 *  - Right image is placed at (leftW - overlapPx, tyPx), rotated by `angleDeg`
 *    around its own center.
 *
 * The composite canvas height equals the left height. Right pixels that fall
 * outside this box are clipped.
 *
 * @param {HTMLCanvasElement} left
 * @param {HTMLCanvasElement} right
 * @param {{overlapMm:number, tyMm:number, angleDeg:number}} align
 * @returns {HTMLCanvasElement}
 */
export function composePair(left, right, align) {
  const overlapPx = Math.max(0, Math.min(MAX_OVERLAP_MM, align.overlapMm)) * PX_PER_MM;
  const tyPx = align.tyMm * PX_PER_MM;
  const angleRad = (align.angleDeg * Math.PI) / 180;

  const width = Math.round(left.width + right.width - overlapPx);
  const height = Math.max(left.height, right.height);

  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);

  // Left fixed at (0, 0)
  ctx.drawImage(left, 0, 0);

  // Right shifted + rotated around its center
  const rx = left.width - overlapPx + right.width / 2;
  const ry = right.height / 2 + tyPx;
  ctx.save();
  ctx.translate(rx, ry);
  ctx.rotate(angleRad);
  ctx.drawImage(right, -right.width / 2, -right.height / 2);
  ctx.restore();

  return out;
}

/**
 * Return the x coordinate (in composite pixels) of the join line.
 * The join is the midpoint of the overlap region.
 */
export function getJoinX(left, align) {
  const overlapPx = Math.max(0, Math.min(MAX_OVERLAP_MM, align.overlapMm)) * PX_PER_MM;
  return left.width - overlapPx / 2;
}

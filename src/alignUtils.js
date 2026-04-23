/**
 * Auto-alignment for a pair of A4 half-drawings.
 *
 * Given a left canvas and a right canvas (both rotated + scaled to A4
 * landscape size in pixels), estimate:
 *   - overlapMm: horizontal overlap width in mm (0..60)
 *   - tyMm:     vertical offset of right image relative to left (mm)
 *   - angleDeg: fine rotation of right image (-2..+2 degrees)
 *
 * Strategy: brute-force search on a 4x-downscaled gradient-magnitude image
 * of both halves, scoring candidate alignments by normalized cross-
 * correlation (NCC) over the overlap strip.
 *
 * This is intentionally a simple pure-JS implementation (no OpenCV.js) —
 * the search space is small because the geometry is heavily constrained.
 */

import {
  MAX_OVERLAP_MM,
  DEFAULT_OVERLAP_MM,
  MAX_ROTATION_DEG,
  PX_PER_MM,
} from './constants.js';

const DOWNSCALE = 0.25; // 4x smaller for speed

// -----------------------------------------------------------------------------
// Grayscale + gradient helpers
// -----------------------------------------------------------------------------

function canvasToGray(canvas, scale) {
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, j = 0; i < img.data.length; i += 4, j++) {
    gray[j] =
      0.299 * img.data[i] +
      0.587 * img.data[i + 1] +
      0.114 * img.data[i + 2];
  }
  return { gray, width: w, height: h };
}

/**
 * Sobel-ish gradient magnitude, normalized to 0..1.
 * High values correspond to edges (lines, text strokes) — ideal for matching
 * drawings where content is line-based.
 */
function gradientMagnitude({ gray, width, height }) {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] - 2 * gray[i - 1] - gray[i + width - 1] +
        gray[i - width + 1] + 2 * gray[i + 1] + gray[i + width + 1];
      const gy =
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] +
        gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1];
      out[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  // Normalize to 0..1
  let max = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
  if (max > 0) {
    const inv = 1 / max;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  }
  return { gray: out, width, height };
}

// -----------------------------------------------------------------------------
// Image rotation on Float32 gray maps (for the right image).
// Uses bilinear interpolation. Angle in degrees; positive = CCW.
// Output size equals input size; new pixels are filled with 0.
// -----------------------------------------------------------------------------

function rotateGray({ gray, width, height }, angleDeg) {
  if (angleDeg === 0) return { gray, width, height };
  const out = new Float32Array(width * height);
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Inverse map: destination (x, y) comes from source (sx, sy)
      const dx = x - cx;
      const dy = y - cy;
      // Rotate the destination point by -angle to find the source point
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      if (sx < 0 || sx >= width - 1 || sy < 0 || sy >= height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const i00 = y0 * width + x0;
      const v00 = gray[i00];
      const v10 = gray[i00 + 1];
      const v01 = gray[i00 + width];
      const v11 = gray[i00 + width + 1];
      out[y * width + x] =
        (1 - fx) * (1 - fy) * v00 +
        fx * (1 - fy) * v10 +
        (1 - fx) * fy * v01 +
        fx * fy * v11;
    }
  }
  return { gray: out, width, height };
}

// -----------------------------------------------------------------------------
// NCC over overlap strip.
// Left image right-edge strip (width = overlapPx) is correlated against the
// right image left-edge strip (width = overlapPx) shifted by tyPx vertically.
// Returns a score in [-1, 1] — higher = better match.
// Samples every `step` pixel for speed.
// -----------------------------------------------------------------------------

function nccScore(L, R, overlapPx, tyPx, step = 2) {
  const { gray: lg, width: lw, height: lh } = L;
  const { gray: rg, width: rw, height: rh } = R;
  const overlap = Math.round(overlapPx);
  const ty = Math.round(tyPx);

  // x ranges
  const lxStart = lw - overlap;
  const lxEnd = lw;
  const rxStart = 0;

  // y ranges (intersect the two images vertically after ty offset)
  const yStart = Math.max(0, -ty, 0);
  const yEnd = Math.min(lh, rh - ty);
  if (yEnd - yStart < 10) return -1;

  let sumL = 0;
  let sumR = 0;
  let sumLL = 0;
  let sumRR = 0;
  let sumLR = 0;
  let count = 0;
  for (let y = yStart; y < yEnd; y += step) {
    const ly = y;
    const ry = y + ty;
    if (ry < 0 || ry >= rh) continue;
    for (let xi = 0; xi < overlap; xi += step) {
      const lx = lxStart + xi;
      const rx = rxStart + xi;
      if (lx < 0 || lx >= lw || rx < 0 || rx >= rw) continue;
      const lv = lg[ly * lw + lx];
      const rv = rg[ry * rw + rx];
      sumL += lv;
      sumR += rv;
      sumLL += lv * lv;
      sumRR += rv * rv;
      sumLR += lv * rv;
      count++;
    }
  }
  if (count === 0) return -1;
  const meanL = sumL / count;
  const meanR = sumR / count;
  const varL = sumLL / count - meanL * meanL;
  const varR = sumRR / count - meanR * meanR;
  const cov = sumLR / count - meanL * meanR;
  const denom = Math.sqrt(Math.max(1e-9, varL) * Math.max(1e-9, varR));
  return cov / denom;
}

// -----------------------------------------------------------------------------
// Main alignment entrypoint.
// -----------------------------------------------------------------------------

export async function autoAlign(leftCanvas, rightCanvas, opts = {}) {
  const dsPxPerMm = PX_PER_MM * DOWNSCALE;

  // 1) Downscale + gradient magnitude
  const L0 = canvasToGray(leftCanvas, DOWNSCALE);
  const R0 = canvasToGray(rightCanvas, DOWNSCALE);
  const L = gradientMagnitude(L0);
  const R = gradientMagnitude(R0);

  // 2) Search grid
  const angles = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2]; // degrees
  const minOverlapPx = Math.max(2, 8 * dsPxPerMm);
  const maxOverlapPx = MAX_OVERLAP_MM * dsPxPerMm;
  const overlapStep = Math.max(1, Math.round(2 * dsPxPerMm)); // ~2mm
  const maxTyPx = Math.round(25 * dsPxPerMm); // ±25mm search
  const tyStep = Math.max(1, Math.round(2 * dsPxPerMm));

  let best = {
    score: -Infinity,
    overlapPx: DEFAULT_OVERLAP_MM * dsPxPerMm,
    tyPx: 0,
    angleDeg: 0,
  };

  for (const ang of angles) {
    const Rr = rotateGray(R, ang);
    for (let ov = minOverlapPx; ov <= maxOverlapPx; ov += overlapStep) {
      for (let ty = -maxTyPx; ty <= maxTyPx; ty += tyStep) {
        const s = nccScore(L, Rr, ov, ty, 2);
        if (s > best.score) {
          best = { score: s, overlapPx: ov, tyPx: ty, angleDeg: ang };
        }
      }
    }
  }

  // 3) Refine translation locally at full (downscaled) resolution
  //    for the best rotation.
  {
    const Rr = rotateGray(R, best.angleDeg);
    const range = Math.max(1, Math.round(3 * dsPxPerMm));
    const ov0 = best.overlapPx;
    const ty0 = best.tyPx;
    for (let ov = ov0 - range; ov <= ov0 + range; ov++) {
      if (ov < minOverlapPx || ov > maxOverlapPx) continue;
      for (let ty = ty0 - range; ty <= ty0 + range; ty++) {
        if (Math.abs(ty) > maxTyPx) continue;
        const s = nccScore(L, Rr, ov, ty, 1);
        if (s > best.score) {
          best = { score: s, overlapPx: ov, tyPx: ty, angleDeg: best.angleDeg };
        }
      }
    }
  }

  // Convert back to physical units (full-resolution mm)
  const overlapMm = Math.min(
    MAX_OVERLAP_MM,
    Math.max(0, best.overlapPx / dsPxPerMm),
  );
  const tyMm = Math.max(
    -MAX_OVERLAP_MM,
    Math.min(MAX_OVERLAP_MM, best.tyPx / dsPxPerMm),
  );
  const angleDeg = Math.max(
    -MAX_ROTATION_DEG,
    Math.min(MAX_ROTATION_DEG, best.angleDeg),
  );

  return {
    overlapMm,
    tyMm,
    angleDeg,
    score: best.score,
    success: best.score > 0.2, // heuristic threshold
  };
}

/**
 * Auto-alignment for a pair of A4 half-drawings.
 *
 * Given a left canvas and a right canvas (both rotated + scaled to A4
 * landscape size in pixels), estimate:
 *   - overlapMm: horizontal overlap width in mm (0..60)
 *   - tyMm:     vertical offset of right image relative to left (mm)
 *   - angleDeg: fine rotation of right image (-2..+2 degrees)
 *
 * Strategy:
 *   1. Build a binarised edge mask (ink vs paper) at two resolutions.
 *   2. Coarse search at 1/4 resolution across {angle, overlap, ty}.
 *   3. Refine angle at 0.1° step around the best coarse angle.
 *   4. Refine translation at 1/2 resolution around the coarse peak.
 *   5. Sub-pixel parabolic fit on (ty, overlap) for the final peak.
 *
 * The score is a normalised cross-correlation over the overlap strip
 * computed on the binarised edge mask so that "ink aligns with ink" is what
 * drives the peak, not bulk grayscale variation.
 */

import {
  MAX_OVERLAP_MM,
  DEFAULT_OVERLAP_MM,
  MAX_ROTATION_DEG,
  PX_PER_MM,
} from './constants.js';

const COARSE_SCALE = 0.25; // 4x smaller
const FINE_SCALE = 0.5; // 2x smaller

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
  let max = 0;
  for (let i = 0; i < out.length; i++) if (out[i] > max) max = out[i];
  if (max > 0) {
    const inv = 1 / max;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  }
  return { gray: out, width, height };
}

/**
 * Binarise an already-normalised gradient map.
 * Values above `threshold` become 1; others become 0. This focuses the NCC on
 * ink vs paper rather than on bulk grayscale contrast, so large empty margins
 * no longer dominate the score.
 */
function binarise({ gray, width, height }, threshold = 0.15) {
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] > threshold ? 1 : 0;
  return { gray: out, width, height };
}

// -----------------------------------------------------------------------------
// Image rotation on Float32 gray maps (for the right image).
// Uses bilinear interpolation. Angle in degrees; positive = CCW.
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
      const dx = x - cx;
      const dy = y - cy;
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
// -----------------------------------------------------------------------------

function nccScore(L, R, overlapPx, tyPx, step = 2) {
  const { gray: lg, width: lw, height: lh } = L;
  const { gray: rg, width: rw, height: rh } = R;
  const overlap = Math.round(overlapPx);
  const ty = Math.round(tyPx);

  const lxStart = lw - overlap;
  const rxStart = 0;

  const yStart = Math.max(0, -ty);
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
// Build the feature map used for matching at a given canvas scale.
// -----------------------------------------------------------------------------

function makeFeatureMap(canvas, scale) {
  const gray = canvasToGray(canvas, scale);
  const grad = gradientMagnitude(gray);
  return binarise(grad, 0.15);
}

// -----------------------------------------------------------------------------
// Parabolic sub-pixel fit: given three samples f(-1), f(0), f(1), return the
// peak offset in [-1, 1].
// -----------------------------------------------------------------------------

function parabolicPeak(fm1, f0, fp1) {
  const denom = fm1 - 2 * f0 + fp1;
  if (Math.abs(denom) < 1e-9) return 0;
  const d = 0.5 * (fm1 - fp1) / denom;
  if (d > 1 || d < -1) return 0;
  return d;
}

// -----------------------------------------------------------------------------
// Main alignment entrypoint.
// -----------------------------------------------------------------------------

export async function autoAlign(leftCanvas, rightCanvas, _opts = {}) {
  // -------- 1) Coarse search at COARSE_SCALE ---------------------------------
  const cPx = PX_PER_MM * COARSE_SCALE;
  const Lc = makeFeatureMap(leftCanvas, COARSE_SCALE);
  const Rc = makeFeatureMap(rightCanvas, COARSE_SCALE);

  const coarseAngles = [];
  for (let a = -MAX_ROTATION_DEG; a <= MAX_ROTATION_DEG + 1e-9; a += 0.5) {
    coarseAngles.push(Math.round(a * 100) / 100);
  }
  const cMinOv = Math.max(2, 8 * cPx);
  const cMaxOv = MAX_OVERLAP_MM * cPx;
  const cOvStep = Math.max(1, Math.round(2 * cPx));
  const cMaxTy = Math.round(25 * cPx);
  const cTyStep = Math.max(1, Math.round(2 * cPx));

  let coarseBest = {
    score: -Infinity,
    overlapPx: DEFAULT_OVERLAP_MM * cPx,
    tyPx: 0,
    angleDeg: 0,
  };
  for (const ang of coarseAngles) {
    const Rr = rotateGray(Rc, ang);
    for (let ov = cMinOv; ov <= cMaxOv; ov += cOvStep) {
      for (let ty = -cMaxTy; ty <= cMaxTy; ty += cTyStep) {
        const s = nccScore(Lc, Rr, ov, ty, 2);
        if (s > coarseBest.score) {
          coarseBest = { score: s, overlapPx: ov, tyPx: ty, angleDeg: ang };
        }
      }
    }
  }

  // Convert coarse translation into mm so we can reuse it at the finer scale.
  const coarseOverlapMm = coarseBest.overlapPx / cPx;
  const coarseTyMm = coarseBest.tyPx / cPx;

  // -------- 2) Angle refinement at COARSE_SCALE (0.1° step) ------------------
  let bestAngleDeg = coarseBest.angleDeg;
  {
    const angleStep = 0.1;
    const lo = Math.max(-MAX_ROTATION_DEG, coarseBest.angleDeg - 0.5);
    const hi = Math.min(MAX_ROTATION_DEG, coarseBest.angleDeg + 0.5);
    let bestScore = -Infinity;
    const ovPx = coarseBest.overlapPx;
    const tyPx = coarseBest.tyPx;
    for (let a = lo; a <= hi + 1e-9; a += angleStep) {
      const ang = Math.round(a * 100) / 100;
      const Rr = rotateGray(Rc, ang);
      // Evaluate over a tiny 3x3 (ov, ty) neighborhood so the angle choice is
      // robust to small translation errors from the coarse pass.
      const range = Math.max(1, Math.round(1 * cPx));
      let localBest = -Infinity;
      for (let ov = ovPx - range; ov <= ovPx + range; ov += range || 1) {
        for (let ty = tyPx - range; ty <= tyPx + range; ty += range || 1) {
          const s = nccScore(Lc, Rr, ov, ty, 2);
          if (s > localBest) localBest = s;
        }
      }
      if (localBest > bestScore) {
        bestScore = localBest;
        bestAngleDeg = ang;
      }
    }
  }

  // -------- 3) Fine translation search at FINE_SCALE -------------------------
  const fPx = PX_PER_MM * FINE_SCALE;
  const Lf = makeFeatureMap(leftCanvas, FINE_SCALE);
  const Rf = rotateGray(makeFeatureMap(rightCanvas, FINE_SCALE), bestAngleDeg);

  const ovGuess = Math.round(coarseOverlapMm * fPx);
  const tyGuess = Math.round(coarseTyMm * fPx);
  const ovMin = Math.max(2, Math.round(8 * fPx));
  const ovMax = Math.round(MAX_OVERLAP_MM * fPx);
  const tyMax = Math.round(25 * fPx);
  const fineRange = Math.max(1, Math.round(3 * fPx));

  let best = {
    score: -Infinity,
    overlapPx: ovGuess,
    tyPx: tyGuess,
  };
  for (let ov = ovGuess - fineRange; ov <= ovGuess + fineRange; ov++) {
    if (ov < ovMin || ov > ovMax) continue;
    for (let ty = tyGuess - fineRange; ty <= tyGuess + fineRange; ty++) {
      if (ty < -tyMax || ty > tyMax) continue;
      const s = nccScore(Lf, Rf, ov, ty, 1);
      if (s > best.score) best = { score: s, overlapPx: ov, tyPx: ty };
    }
  }

  // -------- 4) Sub-pixel refinement via parabolic fit ------------------------
  const subOvPx = (() => {
    const s0 = best.score;
    const sm = nccScore(Lf, Rf, best.overlapPx - 1, best.tyPx, 1);
    const sp = nccScore(Lf, Rf, best.overlapPx + 1, best.tyPx, 1);
    return best.overlapPx + parabolicPeak(sm, s0, sp);
  })();
  const subTyPx = (() => {
    const s0 = best.score;
    const sm = nccScore(Lf, Rf, best.overlapPx, best.tyPx - 1, 1);
    const sp = nccScore(Lf, Rf, best.overlapPx, best.tyPx + 1, 1);
    return best.tyPx + parabolicPeak(sm, s0, sp);
  })();

  // -------- 5) Convert back to physical units (mm) ---------------------------
  const overlapMm = Math.min(
    MAX_OVERLAP_MM,
    Math.max(0, subOvPx / fPx),
  );
  const tyMm = Math.max(
    -MAX_OVERLAP_MM,
    Math.min(MAX_OVERLAP_MM, subTyPx / fPx),
  );
  const angleDeg = Math.max(
    -MAX_ROTATION_DEG,
    Math.min(MAX_ROTATION_DEG, bestAngleDeg),
  );

  return {
    overlapMm,
    tyMm,
    angleDeg,
    score: best.score,
    success: best.score > 0.2,
  };
}

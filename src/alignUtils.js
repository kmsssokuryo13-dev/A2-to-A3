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
 *   1. Build a binarised edge mask (ink vs paper) at coarse and fine scales.
 *   2. Coarse search at 1/4 resolution across {angle, overlap, ty}, keeping
 *      the top-K distinct candidates (not just the global max — the coarse
 *      grid can snap to a slightly off peak).
 *   3. Refine each candidate: first at coarse scale with 0.1° angle step,
 *      then at fine (1/2) scale with 1-pixel (≈0.23 mm) translation step.
 *   4. Pick the candidate with the best fine-scale score.
 *   5. Sub-pixel parabolic fit on (ty, overlap) at fine scale.
 *
 * Notes:
 * - The score is a normalised cross-correlation on a binarised edge mask, so
 *   empty paper margins no longer dominate.
 * - Minimum overlap is 0 mm (previously 8 mm). Some scans have essentially
 *   no physical overlap and the old lower bound forced a spurious overlap.
 * - Small rotations are mildly penalised so that the algorithm does not
 *   chase a 0.5° rotation that only wins by a few parts in 1000 — on
 *   digital PDFs the true angle is usually exactly 0.
 */

import {
  MAX_OVERLAP_MM,
  DEFAULT_OVERLAP_MM,
  MAX_ROTATION_DEG,
  PX_PER_MM,
} from './constants.js';

const COARSE_SCALE = 0.25;
const FINE_SCALE = 0.5;
// Number of distinct (angle, overlap, ty) peaks to keep from the coarse pass
// and refine individually at fine scale. Helps escape shallow local maxima
// caused by the coarse grid.
const TOP_K_COARSE = 6;
// Penalty applied to |angleDeg| when comparing candidates. 0.001 / degree is
// roughly the noise floor of NCC; this keeps us from preferring a 0.5°
// rotation that only improves the score by < 0.0005.
const ANGLE_PENALTY_PER_DEG = 0.004;

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

function binarise({ gray, width, height }, threshold = 0.15) {
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = gray[i] > threshold ? 1 : 0;
  return { gray: out, width, height };
}

function makeFeatureMap(canvas, scale) {
  const gray = canvasToGray(canvas, scale);
  const grad = gradientMagnitude(gray);
  return binarise(grad, 0.15);
}

// -----------------------------------------------------------------------------
// Image rotation on Float32 gray maps.
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
  if (overlap < 2) return -1;

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

function penalisedScore(score, angleDeg) {
  return score - ANGLE_PENALTY_PER_DEG * Math.abs(angleDeg);
}

// -----------------------------------------------------------------------------
// Top-K insertion with de-duplication by (angle, overlap neighbourhood).
// -----------------------------------------------------------------------------

function insertTopK(topK, candidate, k, ovTol, tyTol) {
  // Drop any existing candidate that is too close to the new one: the new
  // one replaces it if it scores higher.
  for (let i = 0; i < topK.length; i++) {
    const c = topK[i];
    if (
      c.angleDeg === candidate.angleDeg &&
      Math.abs(c.overlapPx - candidate.overlapPx) <= ovTol &&
      Math.abs(c.tyPx - candidate.tyPx) <= tyTol
    ) {
      if (candidate.penScore > c.penScore) topK[i] = candidate;
      return;
    }
  }
  topK.push(candidate);
  topK.sort((a, b) => b.penScore - a.penScore);
  if (topK.length > k) topK.length = k;
}

// -----------------------------------------------------------------------------
// Parabolic sub-pixel fit.
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
  const cMinOv = 2; // allow overlap from 0 mm upward (2px is the NCC floor)
  const cMaxOv = MAX_OVERLAP_MM * cPx;
  const cOvStep = Math.max(1, Math.round(2 * cPx)); // ≈ 2 mm
  const cMaxTy = Math.round(25 * cPx); // ±25 mm search
  const cTyStep = Math.max(1, Math.round(2 * cPx));

  const topK = [];
  const ovDedup = Math.max(1, Math.round(3 * cPx)); // dedup within ~3 mm
  const tyDedup = Math.max(1, Math.round(3 * cPx));

  for (const ang of coarseAngles) {
    const Rr = rotateGray(Rc, ang);
    for (let ov = cMinOv; ov <= cMaxOv; ov += cOvStep) {
      for (let ty = -cMaxTy; ty <= cMaxTy; ty += cTyStep) {
        const s = nccScore(Lc, Rr, ov, ty, 2);
        if (s <= 0) continue;
        const pen = penalisedScore(s, ang);
        insertTopK(
          topK,
          { score: s, penScore: pen, overlapPx: ov, tyPx: ty, angleDeg: ang },
          TOP_K_COARSE,
          ovDedup,
          tyDedup,
        );
      }
    }
  }

  if (topK.length === 0) {
    // Nothing correlated — bail out with a sensible default.
    return {
      overlapMm: DEFAULT_OVERLAP_MM,
      tyMm: 0,
      angleDeg: 0,
      score: 0,
      success: false,
    };
  }

  // -------- 2) For each coarse candidate, refine angle at 0.1° step ----------
  const angleRefined = topK.map((c) => refineAngle(Lc, Rc, c, cPx));

  // -------- 3) Refine translation at FINE_SCALE for each candidate -----------
  const fPx = PX_PER_MM * FINE_SCALE;
  const Lf = makeFeatureMap(leftCanvas, FINE_SCALE);
  const RfBase = makeFeatureMap(rightCanvas, FINE_SCALE);
  const fineRange = Math.max(1, Math.round(4 * fPx)); // ±4 mm fine search
  const ovMin = 2;
  const ovMax = Math.round(MAX_OVERLAP_MM * fPx);
  const tyMax = Math.round(25 * fPx);

  let best = null;
  for (const cand of angleRefined) {
    const Rf = rotateGray(RfBase, cand.angleDeg);
    const ovGuess = Math.round((cand.overlapPx / cPx) * fPx);
    const tyGuess = Math.round((cand.tyPx / cPx) * fPx);

    let localBest = null;
    for (let ov = ovGuess - fineRange; ov <= ovGuess + fineRange; ov++) {
      if (ov < ovMin || ov > ovMax) continue;
      for (let ty = tyGuess - fineRange; ty <= tyGuess + fineRange; ty++) {
        if (ty < -tyMax || ty > tyMax) continue;
        const s = nccScore(Lf, Rf, ov, ty, 1);
        if (s <= 0) continue;
        const pen = penalisedScore(s, cand.angleDeg);
        if (!localBest || pen > localBest.penScore) {
          localBest = {
            score: s,
            penScore: pen,
            overlapPx: ov,
            tyPx: ty,
            angleDeg: cand.angleDeg,
            Rf,
          };
        }
      }
    }
    if (localBest && (!best || localBest.penScore > best.penScore)) {
      best = localBest;
    }
  }

  if (!best) {
    return {
      overlapMm: DEFAULT_OVERLAP_MM,
      tyMm: 0,
      angleDeg: 0,
      score: 0,
      success: false,
    };
  }

  // -------- 4) Sub-pixel refinement via parabolic fit ------------------------
  const subOvPx = (() => {
    const s0 = best.score;
    const sm = nccScore(Lf, best.Rf, best.overlapPx - 1, best.tyPx, 1);
    const sp = nccScore(Lf, best.Rf, best.overlapPx + 1, best.tyPx, 1);
    return best.overlapPx + parabolicPeak(sm, s0, sp);
  })();
  const subTyPx = (() => {
    const s0 = best.score;
    const sm = nccScore(Lf, best.Rf, best.overlapPx, best.tyPx - 1, 1);
    const sp = nccScore(Lf, best.Rf, best.overlapPx, best.tyPx + 1, 1);
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
    Math.min(MAX_ROTATION_DEG, best.angleDeg),
  );

  return {
    overlapMm,
    tyMm,
    angleDeg,
    score: best.score,
    success: best.score > 0.2,
  };
}

/**
 * Refine the angle of a coarse candidate at 0.1° step around `c.angleDeg`.
 * Evaluates over a 3×3 (overlap, ty) neighbourhood for robustness.
 */
function refineAngle(Lc, Rc, c, cPx) {
  const angleStep = 0.1;
  const lo = Math.max(-MAX_ROTATION_DEG, c.angleDeg - 0.5);
  const hi = Math.min(MAX_ROTATION_DEG, c.angleDeg + 0.5);
  const nRange = Math.max(1, Math.round(1 * cPx));
  let bestAngle = c.angleDeg;
  let bestPen = c.penScore;
  let bestScore = c.score;
  for (let a = lo; a <= hi + 1e-9; a += angleStep) {
    const ang = Math.round(a * 100) / 100;
    const Rr = rotateGray(Rc, ang);
    let localBest = -Infinity;
    for (let ov = c.overlapPx - nRange; ov <= c.overlapPx + nRange; ov += nRange || 1) {
      for (let ty = c.tyPx - nRange; ty <= c.tyPx + nRange; ty += nRange || 1) {
        const s = nccScore(Lc, Rr, ov, ty, 2);
        if (s > localBest) localBest = s;
      }
    }
    const pen = penalisedScore(localBest, ang);
    if (pen > bestPen) {
      bestPen = pen;
      bestAngle = ang;
      bestScore = localBest;
    }
  }
  return { ...c, angleDeg: bestAngle, penScore: bestPen, score: bestScore };
}

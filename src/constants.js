// Page size constants (in PDF points, 72 DPI)
// 1 mm = 2.83464567 pt
export const MM_TO_PT = 72 / 25.4;

// ISO paper sizes in mm
export const A3_W_MM = 297;
export const A3_H_MM = 420;
export const A4_W_MM = 210;
export const A4_H_MM = 297;

// ISO paper sizes in pt
export const A3_W_PT = A3_W_MM * MM_TO_PT; // 841.89
export const A3_H_PT = A3_H_MM * MM_TO_PT; // 1190.55
export const A4_W_PT = A4_W_MM * MM_TO_PT; // 595.28
export const A4_H_PT = A4_H_MM * MM_TO_PT; // 841.89

// Internal rendering DPI (higher = better quality, larger files)
export const RENDER_DPI = 220;

// Pixels-per-mm at RENDER_DPI
export const PX_PER_MM = RENDER_DPI / 25.4;

// Maximum allowed overlap between left/right halves (in mm)
export const MAX_OVERLAP_MM = 60; // 6cm
// Default overlap used when auto-alignment fails (in mm)
export const DEFAULT_OVERLAP_MM = 30; // 3cm
// Maximum fine-tuning rotation for right page (degrees)
export const MAX_ROTATION_DEG = 2;

// A4 size in pixels at RENDER_DPI
export const A4_W_PX = Math.round(A4_W_MM * PX_PER_MM);
export const A4_H_PX = Math.round(A4_H_MM * PX_PER_MM);

// JPEG output quality (color mode)
export const COLOR_JPEG_QUALITY = 0.85;
// JPEG output quality (mono mode) - higher, but compresses well due to limited palette
export const MONO_JPEG_QUALITY = 0.92;

// Default monochrome threshold (0..255). Below this = black, above = white.
export const DEFAULT_MONO_THRESHOLD = 180;

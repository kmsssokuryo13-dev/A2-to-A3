import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_OVERLAP_MM,
  DEFAULT_MONO_THRESHOLD,
  MAX_OVERLAP_MM,
  MAX_ROTATION_DEG,
} from './constants.js';
import { loadPdf, renderPageToCanvas, stripExt } from './pdfUtils.js';
import { rotate90, scaleUniform } from './imageUtils.js';
import { autoAlign } from './alignUtils.js';
import { composePair, getJoinX } from './compose.js';
import { exportToPdf } from './pdfExport.js';
import './App.css';

/**
 * A2 to A3 — figure PDF auto-merge / split app.
 *
 * Given a PDF whose pages are the two halves of an A2-landscape drawing
 * scanned as A3-portrait (left half = odd pages, right half = even pages),
 * this app reconstructs the full drawing and exports 3 pages per pair:
 *   1. Reassembled A3 landscape (with name label, join line, ①②)
 *   2. Original left A3 portrait half (with ①)
 *   3. Original right A3 portrait half (with ②)
 */
export default function App() {
  const [fileName, setFileName] = useState('');
  const [pairs, setPairs] = useState([]); // see preparePair()
  const [currentIdx, setCurrentIdx] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState('');
  const [monochrome, setMonochrome] = useState(true);
  const [monoThreshold, setMonoThreshold] = useState(DEFAULT_MONO_THRESHOLD);
  const [isExporting, setIsExporting] = useState(false);
  const [previewScale, setPreviewScale] = useState(0.2);
  const [errorMessage, setErrorMessage] = useState('');

  const previewCanvasRef = useRef(null);
  const scrollerRef = useRef(null);

  const current = pairs[currentIdx];

  // ----------------------------------------------------------------- Upload
  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setErrorMessage('');
    setIsProcessing(true);
    setPairs([]);
    setFileName(stripExt(file.name));
    try {
      const pdf = await loadPdf(file);
      const pageCount = pdf.numPages;
      if (pageCount % 2 !== 0) {
        throw new Error(
          `PDF のページ数は偶数である必要があります（現在 ${pageCount} ページ）。`,
        );
      }
      const pairCount = pageCount / 2;
      const newPairs = [];
      for (let i = 0; i < pairCount; i++) {
        setProgress(`図面 ${i + 1} / ${pairCount} を処理中…`);
        const leftIdx = i * 2 + 1;
        const rightIdx = i * 2 + 2;
        const leftRaw = await renderPageToCanvas(pdf, leftIdx);
        const rightRaw = await renderPageToCanvas(pdf, rightIdx);

        // Rotate (left: CCW / 左回転, right: CW / 右回転).
        const leftRot = rotate90(leftRaw.canvas, 'ccw');
        const rightRot = rotate90(rightRaw.canvas, 'cw');

        // "A3→A4 縮小" — halve the area while preserving each source's
        // aspect ratio (每 dim × 1/√2). Rule: 縦横比は絶対に変えない.
        const A3_TO_A4 = 1 / Math.SQRT2;
        const leftA4 = scaleUniform(leftRot, A3_TO_A4);
        const rightA4 = scaleUniform(rightRot, A3_TO_A4);

        // Auto-align
        setProgress(`図面 ${i + 1} / ${pairCount} 自動位置合わせ中…`);
        const alignment = await autoAlign(leftA4, rightA4);
        newPairs.push({
          index: i,
          drawingName: pairCount === 1 ? '' : `図面${i + 1}`,
          leftOriginal: leftRaw.canvas,
          rightOriginal: rightRaw.canvas,
          leftOriginalPt: { width: leftRaw.widthPt, height: leftRaw.heightPt },
          rightOriginalPt: { width: rightRaw.widthPt, height: rightRaw.heightPt },
          leftA4,
          rightA4,
          alignment: alignment.success
            ? {
                overlapMm: alignment.overlapMm,
                tyMm: alignment.tyMm,
                angleDeg: alignment.angleDeg,
              }
            : {
                overlapMm: DEFAULT_OVERLAP_MM,
                tyMm: 0,
                angleDeg: 0,
              },
          autoAlign: alignment,
        });
      }
      setPairs(newPairs);
      setCurrentIdx(0);
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message || String(err));
    } finally {
      setIsProcessing(false);
      setProgress('');
    }
  };

  // ------------------------------------------------------------- Preview
  // Re-render the preview canvas whenever alignment / current pair / mono
  // changes.
  useEffect(() => {
    if (!current) return;
    const canvas = previewCanvasRef.current;
    if (!canvas) return;
    const composite = composePair(current.leftA4, current.rightA4, current.alignment);

    const scale = previewScale;
    canvas.width = Math.round(composite.width * scale);
    canvas.height = Math.round(composite.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(composite, 0, 0, canvas.width, canvas.height);

    // Overlay join line (red, semi-transparent)
    const joinX = getJoinX(current.leftA4, current.alignment) * scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(220,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(joinX, 0);
    ctx.lineTo(joinX, canvas.height);
    ctx.stroke();
    ctx.restore();
  }, [current, previewScale, monochrome, monoThreshold]);

  // ------------------------------------------------------ Drag-to-scroll
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    let isDown = false;
    let sx = 0;
    let sy = 0;
    let sl = 0;
    let st = 0;
    const onDown = (e) => {
      isDown = true;
      sx = e.clientX;
      sy = e.clientY;
      sl = el.scrollLeft;
      st = el.scrollTop;
      el.style.cursor = 'grabbing';
    };
    const onMove = (e) => {
      if (!isDown) return;
      el.scrollLeft = sl - (e.clientX - sx);
      el.scrollTop = st - (e.clientY - sy);
    };
    const onUp = () => {
      isDown = false;
      el.style.cursor = 'grab';
    };
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousedown', onDown);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // The preview scroller is conditionally rendered. Re-run whenever it
    // mounts/unmounts so the listeners are attached against the actual node.
  }, [current]);

  // ------------------------------------------------------- Alignment edit
  const updateAlign = (patch) => {
    setPairs((old) => {
      const next = [...old];
      next[currentIdx] = {
        ...next[currentIdx],
        alignment: { ...next[currentIdx].alignment, ...patch },
      };
      return next;
    });
  };

  const setDrawingName = (name) => {
    setPairs((old) => {
      const next = [...old];
      next[currentIdx] = { ...next[currentIdx], drawingName: name };
      return next;
    });
  };

  const reAutoAlign = async () => {
    if (!current) return;
    setIsProcessing(true);
    setProgress('自動位置合わせ中…');
    try {
      const a = await autoAlign(current.leftA4, current.rightA4);
      setPairs((old) => {
        const next = [...old];
        next[currentIdx] = {
          ...next[currentIdx],
          alignment: {
            overlapMm: a.success ? a.overlapMm : DEFAULT_OVERLAP_MM,
            tyMm: a.success ? a.tyMm : 0,
            angleDeg: a.success ? a.angleDeg : 0,
          },
          autoAlign: a,
        };
        return next;
      });
    } finally {
      setIsProcessing(false);
      setProgress('');
    }
  };

  // ---------------------------------------------------------------- Export
  const onExport = async () => {
    if (pairs.length === 0) return;
    setIsExporting(true);
    try {
      const { bytes, filename } = await exportToPdf(pairs, {
        monochrome,
        monoThreshold,
        fileBaseName: fileName || 'output',
      });
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message || String(err));
    } finally {
      setIsExporting(false);
    }
  };

  // ------------------------------------------------------------------ UI
  return (
    <div className="app">
      <header className="header">
        <h1>A2 to A3 — 図面PDF自動結合・分割アプリ</h1>
        <p className="subtitle">
          A2 図面を A3 2 枚でスキャンした PDF を読み込み、自動で結合 →
          3 ページ構成（結合図 + 左右分割図）の PDF として出力します。
          ファイルはすべてブラウザ上で処理され、サーバーに送信されません。
        </p>
      </header>

      <section className="controls">
        <label className="file-input">
          <input
            type="file"
            accept="application/pdf"
            onChange={onPickFile}
            disabled={isProcessing}
          />
          <span>PDF を選択</span>
        </label>
        {fileName && (
          <span className="file-name">入力: {fileName}.pdf</span>
        )}
        <label className="toggle">
          <input
            type="checkbox"
            checked={monochrome}
            onChange={(e) => setMonochrome(e.target.checked)}
          />
          モノクロ化（ファイルサイズ削減）
        </label>
        {monochrome && (
          <label className="threshold">
            閾値
            <input
              type="range"
              min={80}
              max={230}
              value={monoThreshold}
              onChange={(e) => setMonoThreshold(Number(e.target.value))}
            />
            <span>{monoThreshold}</span>
          </label>
        )}
        <button
          className="primary"
          onClick={onExport}
          disabled={pairs.length === 0 || isExporting}
        >
          {isExporting ? '出力中…' : 'PDF を出力'}
        </button>
      </section>

      {errorMessage && <div className="error">{errorMessage}</div>}
      {progress && <div className="progress">{progress}</div>}

      {pairs.length > 1 && (
        <nav className="tabs">
          {pairs.map((p, i) => (
            <button
              key={i}
              className={i === currentIdx ? 'tab active' : 'tab'}
              onClick={() => setCurrentIdx(i)}
            >
              図面 {i + 1}
            </button>
          ))}
        </nav>
      )}

      {current && (
        <section className="editor">
          <div className="toolbar">
            <label>
              図面名
              <input
                type="text"
                value={current.drawingName}
                onChange={(e) => setDrawingName(e.target.value)}
                placeholder="平面図"
              />
              <span className="suffix">全体</span>
            </label>

            <label>
              のり代 (mm)
              <input
                type="range"
                min={0}
                max={MAX_OVERLAP_MM}
                step={0.5}
                value={current.alignment.overlapMm}
                onChange={(e) =>
                  updateAlign({ overlapMm: Number(e.target.value) })
                }
              />
              <input
                type="number"
                step={0.5}
                min={0}
                max={MAX_OVERLAP_MM}
                value={Math.round(current.alignment.overlapMm * 10) / 10}
                onChange={(e) =>
                  updateAlign({
                    overlapMm: clamp(Number(e.target.value), 0, MAX_OVERLAP_MM),
                  })
                }
              />
            </label>

            <label>
              Y オフセット (mm)
              <input
                type="number"
                step={0.5}
                value={Math.round(current.alignment.tyMm * 10) / 10}
                onChange={(e) =>
                  updateAlign({ tyMm: Number(e.target.value) })
                }
              />
            </label>

            <label>
              回転 (°)
              <input
                type="number"
                step={0.1}
                min={-MAX_ROTATION_DEG}
                max={MAX_ROTATION_DEG}
                value={Math.round(current.alignment.angleDeg * 100) / 100}
                onChange={(e) =>
                  updateAlign({
                    angleDeg: clamp(
                      Number(e.target.value),
                      -MAX_ROTATION_DEG,
                      MAX_ROTATION_DEG,
                    ),
                  })
                }
              />
            </label>

            <button onClick={reAutoAlign} disabled={isProcessing}>
              自動位置合わせ
            </button>

            <label>
              プレビュー倍率
              <input
                type="range"
                min={0.1}
                max={0.5}
                step={0.05}
                value={previewScale}
                onChange={(e) => setPreviewScale(Number(e.target.value))}
              />
              <span>{Math.round(previewScale * 100)}%</span>
            </label>
          </div>

          <div className="preview" ref={scrollerRef}>
            <canvas ref={previewCanvasRef} className="preview-canvas" />
          </div>

          {current.autoAlign && (
            <div className="align-info">
              自動位置合わせスコア: {current.autoAlign.score.toFixed(3)}
              {' / '}
              提案値: のり代{' '}
              {current.autoAlign.overlapMm.toFixed(1)}mm, Y{' '}
              {current.autoAlign.tyMm.toFixed(1)}mm, 回転{' '}
              {current.autoAlign.angleDeg.toFixed(2)}°
            </div>
          )}
        </section>
      )}

      {!current && !isProcessing && (
        <section className="placeholder">
          <p>
            A2 図面を A3 2 枚でスキャンした PDF を選択してください。
            複数図面（4 ページ、6 ページ…）にも対応しています。
          </p>
        </section>
      )}
    </div>
  );
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

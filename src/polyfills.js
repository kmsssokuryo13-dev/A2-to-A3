// Polyfills for APIs required by pdfjs-dist (non-legacy build) that are not
// yet universally available.
//
// `Uint8Array.prototype.toHex()` is part of the TC39 "Uint8Array base64/hex"
// proposal. It is shipping in recent Chromium but not yet in Safari/Firefox
// stable as of 2025. pdfjs-dist's main build calls it when computing a PDF
// fingerprint and crashes (`hashOriginal.toHex is not a function`) on
// browsers that lack it.
if (typeof Uint8Array.prototype.toHex !== 'function') {
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    value: function toHex() {
      let out = '';
      for (let i = 0; i < this.length; i++) {
        out += this[i].toString(16).padStart(2, '0');
      }
      return out;
    },
    writable: true,
    configurable: true,
  });
}

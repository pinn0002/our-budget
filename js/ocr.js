// Receipt scanning runs entirely on the phone with Tesseract.js (WebAssembly).
// The photo never leaves the device; only the OCR engine and English model files
// are downloaded the first time (then cached).

import { parseReceipt } from './model.js';

const TESSERACT_SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_SRC;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error('Could not load the scanner. Check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading;
}

// Shrink big phone photos and boost contrast so OCR is faster and more accurate.
async function prepare(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.filter = 'grayscale(1) contrast(1.4)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

export async function scanReceipt(file, onProgress = () => {}) {
  onProgress('Loading scanner…');
  await loadTesseract();
  const img = await prepare(file);
  const { data } = await window.Tesseract.recognize(img, 'eng', {
    logger: m => { if (m.status === 'recognizing text') onProgress(`Reading receipt… ${Math.round(m.progress * 100)}%`); },
  });
  return parseReceipt(data.text);
}

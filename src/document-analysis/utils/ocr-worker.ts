/**
 * ocr-worker.ts
 *
 * Module-scoped lazy singleton around tesseract.js for Thai + English OCR.
 *
 * Design decisions (docs/tasks/DOCUMENT_ANALYSIS_PHASE2_TESSERACT_OCR.md §3.2):
 *   - Single worker per process: tesseract.js workers are ~100 MB resident;
 *     we never hot-cycle them.
 *   - Languages: `tha+eng` — government docs are mixed.
 *   - Language data source:
 *       * If env `TESSERACT_LANG_PATH` is set, load trained data from disk
 *         (production / air-gapped friendly).
 *       * Otherwise let tesseract.js auto-download from its CDN on first use
 *         (~13 MB tha.traineddata). Acceptable for dev + normal deployments.
 *   - Hard timeout via `Promise.race`. On timeout, the worker is NOT
 *     terminated — subsequent requests reuse the same worker. Only the
 *     individual `recognize` call is abandoned.
 *
 * P0 FIX (FIX_OCR_PDF_CRASH_AND_RASTERIZATION):
 *   tesseract.js + leptonica does NOT support PDF input — passing a .pdf
 *   path crashes the Node process via an unhandled MessagePort error
 *   (see task file §1 Incident Log). This module now exposes:
 *     - `ocrBuffer(buf)` — PNG/image Buffer input, used after rasterization
 *     - `rasterizePdfPages(filePath, maxPages)` — PDF → PNG Buffer[] via
 *       `pdf-to-img` (pure JS, no native deps)
 *   Every `worker.recognize()` call is wrapped in try/catch so a native
 *   throw NEVER escapes back into `process.nextTick`.
 *
 * Kept intentionally dep-free of p-limit / async-sema — concurrency is
 * gated upstream by DocumentAnalysisService's Phase 1 semaphore.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

type TesseractWorker = {
  recognize: (
    image: unknown,
  ) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<void>;
};

let workerPromise: Promise<TesseractWorker> | null = null;

export function getOcrWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Dynamic require to match the codebase's pdf-parse pattern and to
      // keep the module boot surface clean when OCR is never invoked.
      const tesseract = require('tesseract.js');
      const options: Record<string, unknown> = {};
      if (process.env.TESSERACT_LANG_PATH) {
        options.langPath = process.env.TESSERACT_LANG_PATH;
        options.cachePath = process.env.TESSERACT_LANG_PATH;
      }
      // createWorker signature in tesseract.js v5:
      //   createWorker(langs, oem=1, options)
      const worker = await tesseract.createWorker('tha+eng', 1, options);
      return worker as TesseractWorker;
    })().catch((err) => {
      // reset so a later caller can retry (e.g., after a transient CDN fail)
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

/**
 * Runs the given promise with a hard timeout. On timeout, resolves with the
 * `onTimeout` sentinel value instead of rejecting, so callers get a clean
 * `unsupported` marker path.
 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  let handle: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(onTimeout()), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

/**
 * Runs OCR against a file path and returns the recognized text, with a hard
 * 60-second cap. Returns an empty string on timeout.
 *
 * IMPORTANT: This path is for IMAGE files only (.jpg/.png/.webp/.bmp/.tiff).
 * NEVER pass a PDF here — tesseract.js's native leptonica backend does NOT
 * support PDF and will crash the process via an unhandled MessagePort error.
 * Use `rasterizePdfPages()` + `ocrBuffer()` for PDF input.
 *
 * Returns `{ text, timedOut, failed }`. On internal throw from
 * tesseract (corrupt / unsupported image), `failed=true` — caller should
 * surface as `unsupported`/`failed`. Never re-throws.
 */
export async function ocrFile(
  filePath: string,
  timeoutMs = 60_000,
): Promise<{ text: string; timedOut: boolean; failed?: boolean; error?: string }> {
  try {
    const worker = await getOcrWorker();
    // Wrap the recognize() call itself in a Promise so any synchronous
    // throw, async rejection, or native MessagePort error surfaces as a
    // rejection we can catch — NEVER reaches process.nextTick.
    const recognition = (async () => {
      try {
        const r = await worker.recognize(filePath);
        return {
          text: (r?.data?.text ?? '').trim(),
          timedOut: false,
        };
      } catch (e) {
        return {
          text: '',
          timedOut: false,
          failed: true,
          error: (e as Error)?.message ?? String(e),
        };
      }
    })();
    return await withTimeout(recognition, timeoutMs, () => ({
      text: '',
      timedOut: true,
    }));
  } catch (e) {
    // Defence-in-depth: getOcrWorker() itself can fail (CDN down, lang file
    // missing). Never bubble — caller expects a plain object.
    return {
      text: '',
      timedOut: false,
      failed: true,
      error: (e as Error)?.message ?? String(e),
    };
  }
}

/**
 * Runs OCR against an in-memory image Buffer (PNG/JPG/WebP/BMP/TIFF).
 * Used for the PDF-OCR path: rasterize → Buffer[] → per-page ocrBuffer().
 *
 * Contract:
 *   - NEVER throws; returns a discriminated-union-shaped result.
 *   - `kind: 'ok'`       — recognized non-empty text
 *   - `kind: 'failed'`   — timeout OR native tesseract error (empty result)
 *
 * The per-page budget defaults to 60_000 ms. The caller (service layer) is
 * responsible for the total wall-clock cap across all pages.
 */
export async function ocrBuffer(
  buf: Buffer,
  timeoutMs = 60_000,
): Promise<
  | { kind: 'ok'; text: string }
  | { kind: 'failed'; reason: string }
> {
  try {
    const worker = await getOcrWorker();
    const recognition = (async () => {
      try {
        // tesseract.js v5 accepts Buffer / Uint8Array for Node image input.
        const r = await worker.recognize(buf);
        const text = (r?.data?.text ?? '').trim();
        return { kind: 'ok' as const, text };
      } catch (e) {
        return {
          kind: 'failed' as const,
          reason: `OCR failed: ${(e as Error)?.message ?? String(e)}`,
        };
      }
    })();
    return await withTimeout<
      | { kind: 'ok'; text: string }
      | { kind: 'failed'; reason: string }
    >(recognition, timeoutMs, () => ({
      kind: 'failed' as const,
      reason: 'OCR failed: timeout',
    }));
  } catch (e) {
    return {
      kind: 'failed',
      reason: `OCR failed: ${(e as Error)?.message ?? String(e)}`,
    };
  }
}

/**
 * Rasterize the first `maxPages` pages of a PDF into PNG Buffers using
 * `pdf-to-img` (pure JS; pdfjs-dist under the hood — no native build step).
 *
 * Throws on failure (encrypted / corrupt PDF). Caller decides whether to
 * surface as `unsupported` vs `failed` — this helper intentionally does
 * NOT swallow so the two failure modes stay distinguishable from OCR
 * failures.
 *
 * `pdf-to-img` is ESM-only; we load via dynamic `import()` to stay
 * compatible with the backend's CommonJS build output.
 */
export async function rasterizePdfPages(
  filePath: string,
  maxPages = 5,
): Promise<Buffer[]> {
  // Dynamic ESM import — tsc emits this as `Promise.resolve().then(() =>
  // require(...))` under CommonJS with moduleResolution node, which would
  // break for a pure-ESM package. Using the Function("return import(...)")
  // trick is overkill; modern Node handles the `await import()` path fine
  // when the host module is CJS.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const dyn = new Function('m', 'return import(m)') as (
    m: string,
  ) => Promise<any>;
  const mod = await dyn('pdf-to-img');
  const pdf = mod.pdf ?? mod.default?.pdf ?? mod.default;
  if (typeof pdf !== 'function') {
    throw new Error('pdf-to-img: pdf() function not found on module export');
  }
  const buffers: Buffer[] = [];
  // `pdf()` returns an async iterable of PNG Buffers (one per page).
  // `scale: 2` gives ~2× density for better OCR accuracy on scans.
  const document = await pdf(filePath, { scale: 2 });
  for await (const page of document) {
    if (buffers.length >= maxPages) break;
    // `page` may be a Buffer already (v4+); older versions return a
    // Uint8Array — coerce to Buffer so downstream tesseract is happy.
    const b = Buffer.isBuffer(page) ? page : Buffer.from(page);
    buffers.push(b);
  }
  return buffers;
}

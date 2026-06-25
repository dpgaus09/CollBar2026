// PDF rasterization + text extraction via mupdf (WASM).
//
// mupdf is ESM and ships a sibling mupdf-wasm.wasm that it loads by path at
// runtime, so it is externalized in esbuild (build.mjs) and lazy-imported here
// — the WASM module is only initialized when extraction actually runs, keeping
// normal API requests free of the cost.

// Bump when the rendering pipeline changes in a way that could alter the pixels
// or text fed to the model (mupdf upgrade, scale math, colorspace). Part of the
// vision cache key so a render change invalidates stale cached extractions.
export const RENDER_VERSION = "mupdf-1.27-v1";

type Mupdf = typeof import("mupdf");

let _mupdf: Promise<Mupdf> | null = null;
function loadMupdf(): Promise<Mupdf> {
  if (!_mupdf) _mupdf = import("mupdf");
  return _mupdf;
}

export interface RenderedPage {
  png: Buffer;
  base64: string;
  width: number;
  height: number;
}

export interface RenderOpts {
  // Target render DPI (72 = native PDF points). Higher = sharper digits.
  dpi?: number;
  // Cap the longest pixel edge; the effective scale is reduced so the long edge
  // never exceeds this (keeps request bodies + image-token cost bounded). 0 = no
  // cap.
  maxPx?: number;
}

export interface PdfDoc {
  pageCount: number;
  // Render a 0-based page index to a PNG (+ base64) for vision.
  renderPage(index: number, opts?: RenderOpts): RenderedPage;
  // Embedded text-layer text for a 0-based page index ("" when scanned).
  pageText(index: number): string;
  // Total text-layer length across all pages (cheap scanned-vs-digital signal).
  totalTextChars(): number;
  // Free WASM-backed resources. Always call when done.
  destroy(): void;
}

export async function openPdf(data: Buffer | Uint8Array): Promise<PdfDoc> {
  const mupdf = await loadMupdf();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  const pageCount = doc.countPages();

  // mupdf Page / Pixmap / StructuredText are WASM handles; type them loosely to
  // avoid coupling to the generated d.ts internals.
  const pageCache = new Map<number, ReturnType<typeof doc.loadPage>>();
  const getPage = (index: number) => {
    if (index < 0 || index >= pageCount) {
      throw new Error(`page index ${index} out of range (0..${pageCount - 1})`);
    }
    let p = pageCache.get(index);
    if (!p) {
      p = doc.loadPage(index);
      pageCache.set(index, p);
    }
    return p;
  };

  const destroyMaybe = (obj: unknown) => {
    const d = (obj as { destroy?: () => void } | null)?.destroy;
    if (typeof d === "function") d.call(obj);
  };

  const pageText = (index: number): string => {
    const page = getPage(index);
    const st = page.toStructuredText();
    try {
      return st.asText();
    } finally {
      destroyMaybe(st);
    }
  };

  return {
    pageCount,

    renderPage(index, opts) {
      const dpi = opts?.dpi ?? 150;
      const maxPx = opts?.maxPx ?? 1600;
      const page = getPage(index);

      let scale = dpi / 72;
      try {
        const b = page.getBounds() as unknown as number[];
        const wPts = b[2] - b[0];
        const hPts = b[3] - b[1];
        const longestPx = Math.max(wPts, hPts) * scale;
        if (maxPx > 0 && longestPx > maxPx) scale *= maxPx / longestPx;
      } catch {
        // getBounds unavailable — fall back to the raw DPI scale.
      }

      const pix = page.toPixmap(
        mupdf.Matrix.scale(scale, scale),
        mupdf.ColorSpace.DeviceRGB,
        false,
      );
      try {
        const png = Buffer.from(pix.asPNG());
        return {
          png,
          base64: png.toString("base64"),
          width: pix.getWidth(),
          height: pix.getHeight(),
        };
      } finally {
        destroyMaybe(pix);
      }
    },

    pageText,

    totalTextChars() {
      let total = 0;
      for (let i = 0; i < pageCount; i++) total += pageText(i).length;
      return total;
    },

    destroy() {
      for (const p of pageCache.values()) destroyMaybe(p);
      pageCache.clear();
      destroyMaybe(doc);
    },
  };
}

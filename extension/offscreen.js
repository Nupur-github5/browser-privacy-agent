// Runs entirely offscreen, with zero third-party network calls: every model
// and runtime file is loaded from this extension's own bundled resources via
// chrome.runtime.getURL(). Face detection (BlazeFace/TFJS) and OCR
// (Tesseract.js) both execute locally; results (bboxes + text + confidence)
// are the only things sent back to the background worker — never the image.

const CANVAS = document.getElementById("scratch-canvas");

let tfBackendReady = null; // Promise<string> — resolves to the backend name actually in use
let faceModel = null;
let ocrWorker = null;

async function ensureTfBackend() {
  if (tfBackendReady) return tfBackendReady;

  tfBackendReady = (async () => {
    const wasmUrl = chrome.runtime.getURL("vendor/tfjs/tfjs-backend-wasm-simd.wasm");
    // Only one wasm variant is bundled (non-threaded SIMD, to avoid requiring
    // cross-origin isolation) — map every filename tfjs-backend-wasm might
    // look for to that single file, and explicitly disable its multithread
    // auto-detection (otherwise it spins up Workers expecting the threaded
    // build's protocol against our non-threaded file, which hangs forever
    // with no error).
    tf.wasm.setWasmPaths({
      "tfjs-backend-wasm.wasm": wasmUrl,
      "tfjs-backend-wasm-simd.wasm": wasmUrl,
      "tfjs-backend-wasm-threaded-simd.wasm": wasmUrl,
    });
    tf.env().set("WASM_HAS_MULTITHREAD_SUPPORT", false);
    tf.wasm.setThreadsCount(1);

    // WebGPU is attempted only when explicitly enabled. Empirically, in a
    // software-rendered environment (swiftshader, e.g. headless Chromium
    // with no real GPU) TFJS's WebGPU backend silently returns wrong
    // (empty) BlazeFace predictions instead of erroring — a genuine
    // hardware/driver correctness gap, not something we can detect
    // generically at runtime. WASM is the verified-correct default; a real
    // GPU may make WebGPU worth re-enabling (window.__PVA_ENABLE_WEBGPU__).
    if (globalThis.__PVA_ENABLE_WEBGPU__) {
      try {
        await tf.setBackend("webgpu");
        await tf.ready();
        if (tf.getBackend() === "webgpu") return "webgpu";
      } catch (e) {
        console.warn("[vision] WebGPU backend unavailable, falling back to WASM:", e.message);
      }
    }

    await tf.setBackend("wasm");
    await tf.ready();
    return tf.getBackend();
  })();

  return tfBackendReady;
}

async function ensureFaceModel() {
  if (faceModel) return faceModel;
  await ensureTfBackend();
  faceModel = await blazeface.load({
    modelUrl: chrome.runtime.getURL("models/blazeface/model.json"),
    // BlazeFace's own default (0.75) filters out real, clearly-visible faces
    // in ordinary photos fairly often (measured ~0.66 confidence on a plain
    // frontal studio portrait) — 0.5 is still well above noise-level scores.
    scoreThreshold: 0.5,
  });
  return faceModel;
}

async function ensureOcrWorker() {
  if (ocrWorker) return ocrWorker;
  ocrWorker = await Tesseract.createWorker("eng", 1, {
    workerPath: chrome.runtime.getURL("vendor/tesseract/worker.min.js"),
    corePath: chrome.runtime.getURL("vendor/tesseract/tesseract-core-simd-lstm.wasm.js"),
    langPath: chrome.runtime.getURL("models/tessdata/"),
    // Tesseract.js normally wraps the worker script in a blob that does
    // importScripts(workerPath) — that blob-origin worker can't reach
    // chrome-extension:// resources even with web_accessible_resources
    // declared, so load worker.min.js directly instead.
    workerBlobURL: false,
    gzip: false,
    logger: () => {},
  });
  return ocrWorker;
}

function loadImageToCanvas(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      CANVAS.width = img.naturalWidth;
      CANVAS.height = img.naturalHeight;
      CANVAS.getContext("2d").drawImage(img, 0, 0);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => reject(new Error("failed to decode screenshot image"));
    img.src = dataUrl;
  });
}

async function detectFaces(dataUrl) {
  const t0 = performance.now();
  const { width, height } = await loadImageToCanvas(dataUrl);
  const provider = await ensureTfBackend();
  const model = await ensureFaceModel();
  const predictions = await model.estimateFaces(CANVAS, false);
  const latencyMs = Math.round(performance.now() - t0);

  const faces = predictions.map((p) => {
    const prob = Array.isArray(p.probability) ? p.probability[0] : p.probability;
    return {
      bbox: {
        x: Math.round(p.topLeft[0]),
        y: Math.round(p.topLeft[1]),
        width: Math.round(p.bottomRight[0] - p.topLeft[0]),
        height: Math.round(p.bottomRight[1] - p.topLeft[1]),
      },
      confidence: Math.round(prob * 100) / 100,
    };
  });

  return { faces, latencyMs, provider, imageWidth: width, imageHeight: height };
}

// Tesseract.js v7's default recognize() doesn't populate the hierarchical
// data.blocks[].paragraphs[].lines[].words[] structure (it's empty unless
// specific output options are requested), but data.tsv is always populated.
// TSV columns: level page_num block_num par_num line_num word_num left top
// width height conf text — parse level 5 (word) rows directly instead.
function parseWordsFromTsv(tsv) {
  const words = [];
  for (const line of (tsv || "").split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 12 || cols[0] !== "5") continue;
    const [, , , , , , left, top, width, height, conf, ...textParts] = cols;
    const text = textParts.join("\t");
    words.push({
      text,
      confidence: parseFloat(conf),
      bbox: { x: parseInt(left, 10), y: parseInt(top, 10), width: parseInt(width, 10), height: parseInt(height, 10) },
    });
  }
  return words;
}

async function detectText(dataUrl) {
  const t0 = performance.now();
  const worker = await ensureOcrWorker();
  // tsv (word-level boxes + confidence) is off by default — only "text" is
  // generated unless explicitly requested via the third (output) argument.
  const { data } = await worker.recognize(dataUrl, {}, { text: false, tsv: true });
  const latencyMs = Math.round(performance.now() - t0);

  const regions = parseWordsFromTsv(data.tsv).filter((w) => w.text && w.text.trim() && w.confidence > 40);

  return { regions, latencyMs, provider: "wasm" };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "RUN_VISION") return false;

  (async () => {
    try {
      const [faceResult, textResult] = await Promise.all([
        detectFaces(message.imageDataUrl).catch((e) => ({ error: e.message, faces: [] })),
        message.skipOcr
          ? Promise.resolve({ regions: [], latencyMs: 0, provider: "skipped" })
          : detectText(message.imageDataUrl).catch((e) => ({ error: e.message, regions: [] })),
      ]);
      sendResponse({ ok: true, face: faceResult, text: textResult });
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();

  return true; // async response
});

console.log("[privacy-vision-agent] offscreen vision worker ready");

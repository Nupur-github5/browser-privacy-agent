// Phase 4 smoke test: local vision (face detection + OCR), no server/LLM
// involved at all — this is a pure client-side capability. Loads the real
// unpacked extension, opens a page with a real face photo and text baked
// into a PNG (not selectable HTML), and asserts the offscreen vision
// pipeline finds both locally, reporting per-inference latency and which
// execution provider (webgpu vs wasm) was actually used.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const jsonMode = process.argv.includes("--json");
const log = (...args) => {
  if (!jsonMode) console.log(...args);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "extension");
const testPagesDir = path.join(repoRoot, "test-pages");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-smoke4-"));

function serveTestPages() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const filePath = path.join(testPagesDir, decodeURIComponent(req.url.split("?")[0]));
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const ext = path.extname(filePath);
        const contentType = { ".html": "text/html", ".jpg": "image/jpeg", ".png": "image/png" }[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const testServer = await serveTestPages();
  const port = testServer.address().port;
  const testPageUrl = `http://127.0.0.1:${port}/vision-test.html`;

  try {
    const chromeBinary = path.join(os.homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: fs.existsSync(chromeBinary) ? chromeBinary : undefined,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        "--headless=new",
        "--enable-unsafe-webgpu",
        "--use-gl=swiftshader",
        "--enable-features=Vulkan",
      ],
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(sw.url()).host;
    log("extension id:", extensionId);
    try {
      sw.on("console", (msg) => log("[sw]", msg.text()));
    } catch {
      // ignore
    }

    const formPage = await context.newPage();
    await formPage.goto(testPageUrl);
    await formPage.waitForLoadState("networkidle");
    await formPage.waitForFunction(() => {
      const img = document.getElementById("portrait");
      return img && img.complete && img.naturalWidth > 0;
    });

    const debugPage = await context.newPage();
    await debugPage.goto(`chrome-extension://${extensionId}/debug.html`);
    await debugPage.waitForTimeout(300);

    log("running vision scan...");
    const t0 = Date.now();
    await debugPage.click("#vision-scan-btn");

    let result = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const text = await debugPage.textContent("#vision-result");
      if (text && text !== "scanning..." && text !== "(no scan yet)") {
        try {
          result = JSON.parse(text);
        } catch {
          // transient
        }
        if (result) break;
      }
      await debugPage.waitForTimeout(500);
    }
    log(`vision scan wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (!result) throw new Error("vision scan did not complete in time");
    log("vision result:", JSON.stringify(result, null, 2));

    if (!result.ok) throw new Error("VISION_SCAN failed: " + JSON.stringify(result));

    // --- Face detection assertions ---
    const face = result.face;
    if (face.error) throw new Error("face detection errored: " + face.error);
    if (!Array.isArray(face.faces) || face.faces.length < 1) {
      throw new Error("expected at least 1 face detected in the portrait, got: " + JSON.stringify(face.faces));
    }
    if (!["webgpu", "wasm"].includes(face.provider)) {
      throw new Error("expected face provider to be webgpu or wasm, got: " + face.provider);
    }
    if (typeof face.latencyMs !== "number" || face.latencyMs <= 0) {
      throw new Error("expected a positive face detection latency, got: " + face.latencyMs);
    }
    log(`face detection: ${face.faces.length} face(s), provider=${face.provider}, latency=${face.latencyMs}ms`);

    // --- OCR assertions ---
    const textResult = result.text;
    if (textResult.error) throw new Error("OCR errored: " + textResult.error);
    const allText = (textResult.regions || []).map((r) => r.text).join(" ");
    log("OCR extracted text:", allText);
    if (!/77219|MISSION|CONTROL|Badge/i.test(allText)) {
      throw new Error(`OCR did not find expected badge text (got: "${allText}")`);
    }
    log(`OCR: ${textResult.regions.length} word region(s), provider=${textResult.provider}, latency=${textResult.latencyMs}ms`);

    log("PHASE 4 SMOKE TEST: PASS");

    if (jsonMode) {
      console.log(
        JSON.stringify({
          ok: true,
          faceLatencyMs: face.latencyMs,
          faceProvider: face.provider,
          facesDetected: face.faces.length,
          ocrLatencyMs: textResult.latencyMs,
          ocrProvider: textResult.provider,
          ocrWordsFound: textResult.regions.length,
        })
      );
    }

    await context.close();
  } finally {
    testServer.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  } else {
    console.error("PHASE 4 SMOKE TEST: FAIL");
    console.error(e);
  }
  process.exit(1);
});

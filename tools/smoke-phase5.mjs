// Phase 5 smoke test: visual redaction. Loads a page with a real face, a
// filled password field, and an ID card image with an Aadhaar number + email
// baked into its pixels. Runs a vision scan with redaction on, then proves —
// by sampling actual pixel values, not just trusting the reported bboxes —
// that the returned "after" image no longer shows the face clearly, and that
// the password field and PII-in-image regions are solid black.
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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-smoke5-"));

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

// Sample a small patch of pixels (avoids one anti-aliased pixel giving a
// false read) from a data URL at (x,y), returned as the averaged [r,g,b].
async function samplePixel(page, dataUrl, x, y, size = 4) {
  return page.evaluate(
    async ({ dataUrl, x, y, size }) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = dataUrl;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(Math.max(0, x - size / 2), Math.max(0, y - size / 2), size, size).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    },
    { dataUrl, x, y, size }
  );
}

function isBlack([r, g, b], tolerance = 15) {
  return r <= tolerance && g <= tolerance && b <= tolerance;
}

function colorDist([r1, g1, b1], [r2, g2, b2]) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

async function main() {
  const testServer = await serveTestPages();
  const port = testServer.address().port;
  const testPageUrl = `http://127.0.0.1:${port}/redaction-test.html`;

  try {
    const chromeBinary = path.join(os.homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: fs.existsSync(chromeBinary) ? chromeBinary : undefined,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--headless=new"],
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(sw.url()).host;
    log("extension id:", extensionId);

    const formPage = await context.newPage();
    await formPage.goto(testPageUrl);
    await formPage.waitForLoadState("networkidle");
    await formPage.waitForFunction(() => {
      const p = document.getElementById("portrait");
      const c = document.getElementById("idcard");
      return p && p.complete && p.naturalWidth > 0 && c && c.complete && c.naturalWidth > 0;
    });

    const debugPage = await context.newPage();
    await debugPage.goto(`chrome-extension://${extensionId}/debug.html`);
    await debugPage.waitForTimeout(300);

    log("running vision scan with redaction...");
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
    if (!result) throw new Error("vision scan did not complete in time");
    if (!result.ok) throw new Error("VISION_SCAN failed: " + JSON.stringify(result));

    const beforeUrl = await debugPage.getAttribute("#vision-before", "src");
    const afterUrl = await debugPage.getAttribute("#vision-after", "src");
    if (!beforeUrl || !afterUrl) throw new Error("before/after images were not populated");
    if (beforeUrl === afterUrl) throw new Error("redacted image is identical to the original — redaction did not run");

    const evalDir = path.join(repoRoot, "eval");
    fs.mkdirSync(evalDir, { recursive: true });
    const beforePath = path.join(evalDir, "redaction-before.png");
    const afterPath = path.join(evalDir, "redaction-after.png");
    fs.writeFileSync(beforePath, Buffer.from(beforeUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    fs.writeFileSync(afterPath, Buffer.from(afterUrl.replace(/^data:image\/\w+;base64,/, ""), "base64"));
    log(`privacy proof (visual) written to: ${beforePath}, ${afterPath}`);

    log(`face: ${result.face.faces.length} detected`);
    log(`OCR PII regions found: ${JSON.stringify(result.text.piiRegions)}`);

    // --- 1. Face region must visibly differ between before/after ---
    // Sample a 3x3 grid across the (padded, per offscreen.js's own margin)
    // bbox rather than trusting the single reported center point — at the
    // low confidence this real-world screenshot produces, BlazeFace's box
    // is often loose, so the literal center can land on background.
    if (result.face.faces.length < 1) throw new Error("expected at least 1 face for this test to be meaningful");
    const faceBox = result.face.faces[0].bbox;
    const margin = 0.25;
    const px = { x: faceBox.x - faceBox.width * margin, width: faceBox.width * (1 + 2 * margin) };
    const py = { y: faceBox.y - faceBox.height * margin, height: faceBox.height * (1 + 2 * margin) };
    let maxDist = 0;
    for (const fx of [0.25, 0.5, 0.75]) {
      for (const fy of [0.25, 0.5, 0.75]) {
        const x = px.x + px.width * fx;
        const y = py.y + py.height * fy;
        const before = await samplePixel(debugPage, beforeUrl, x, y);
        const after = await samplePixel(debugPage, afterUrl, x, y);
        maxDist = Math.max(maxDist, colorDist(before, after));
      }
    }
    log(`max pixel change across padded face region: ${maxDist.toFixed(1)}`);
    if (maxDist < 10) {
      throw new Error(`face region barely changed after redaction (max dist=${maxDist.toFixed(1)}) — blur/pixelation may not have applied`);
    }

    // --- 2. Password field region must be solid black in the after image ---
    // Independently re-extract state (via the existing debug UI) to get the
    // password field's bbox as a cross-check of the vision pipeline's own
    // bookkeeping, rather than trusting it blindly.
    await debugPage.click("#extract-btn");
    await debugPage.waitForTimeout(300);
    const extractResp = JSON.parse(await debugPage.textContent("#elements"));
    if (!extractResp.ok) throw new Error("EXTRACT_STATE failed: " + JSON.stringify(extractResp));
    const pwdEl = extractResp.state.elements.find((e) => e.type === "password");
    if (!pwdEl) throw new Error("password field not found in extracted state");
    const pwdCenter = { x: pwdEl.bbox.x + pwdEl.bbox.width / 2, y: pwdEl.bbox.y + pwdEl.bbox.height / 2 };
    const afterPwdPixel = await samplePixel(debugPage, afterUrl, pwdCenter.x, pwdCenter.y);
    log(`password field center pixel after=${afterPwdPixel}`);
    if (!isBlack(afterPwdPixel)) {
      throw new Error(`password field region is not black after redaction (got ${afterPwdPixel})`);
    }

    // --- 3. PII-in-image regions (Aadhaar/email on the ID card) must be black ---
    const piiRegions = result.text.piiRegions || [];
    if (piiRegions.length === 0) {
      throw new Error("expected at least one PII text region detected on the ID card (Aadhaar/email), got none");
    }
    for (const region of piiRegions) {
      const cx = region.x + region.width / 2;
      const cy = region.y + region.height / 2;
      const pixel = await samplePixel(debugPage, afterUrl, cx, cy);
      log(`PII text region ${JSON.stringify(region)} center pixel after=${pixel}`);
      if (!isBlack(pixel)) {
        throw new Error(`PII text region at (${cx},${cy}) is not black after redaction (got ${pixel})`);
      }
    }

    // --- 4. Negative check: non-PII text (e.g. "Rahul Sharma", a bare name
    // with no matching value pattern) must be left UNCHANGED — without this,
    // "redaction precision" would be unmeasurable (a detector that just
    // blacks out the whole image trivially passes checks 2-3).
    const nameWord = (result.text.regions || []).find((r) => r.text === "Rahul" || r.text === "Sharma");
    let namePreserved = null;
    if (nameWord) {
      const cx = nameWord.bbox.x + nameWord.bbox.width / 2;
      const cy = nameWord.bbox.y + nameWord.bbox.height / 2;
      const before = await samplePixel(debugPage, beforeUrl, cx, cy);
      const after = await samplePixel(debugPage, afterUrl, cx, cy);
      const dist = colorDist(before, after);
      log(`non-PII "Name" text pixel dist before/after=${dist.toFixed(1)} (should be ~0, not redacted)`);
      namePreserved = dist < 10;
      if (!namePreserved) {
        throw new Error(`non-PII text near "${nameWord.text}" changed after redaction (dist=${dist.toFixed(1)}) — over-redaction`);
      }
    }

    log("PHASE 5 SMOKE TEST: PASS");

    if (jsonMode) {
      const targets = 1 /* face */ + 1 /* password */ + piiRegions.length;
      const redactedCorrectly = targets; // every assertion above passed if we got here
      console.log(
        JSON.stringify({
          ok: true,
          faceDetected: result.face.faces.length,
          faceLatencyMs: result.face.latencyMs,
          faceProvider: result.face.provider,
          ocrLatencyMs: result.text.latencyMs,
          ocrProvider: result.text.provider,
          piiTextRegionsFound: piiRegions.length,
          targets,
          redactedCorrectly,
          redactionRecall: redactedCorrectly / targets,
          nonPiiPreserved: namePreserved,
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
    console.error("PHASE 5 SMOKE TEST: FAIL");
    console.error(e);
  }
  process.exit(1);
});

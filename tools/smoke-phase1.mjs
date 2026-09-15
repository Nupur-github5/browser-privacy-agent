// Phase 1 smoke test: loads the unpacked extension in a real Chromium via
// Playwright, extracts the employee-portal form's element list through the
// debug page, fills it using target_ids, submits, and checks the result.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "extension");
const testPagesDir = path.join(repoRoot, "test-pages");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-smoke-"));

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
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function main() {
  const server = await serveTestPages();
  const port = server.address().port;
  const testPageUrl = `http://127.0.0.1:${port}/employee-portal.html`;
  const chromeBinary = path.join(os.homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: fs.existsSync(chromeBinary) ? chromeBinary : undefined,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--headless=new",
    ],
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
  const extensionId = new URL(sw.url()).host;
  console.log("extension id:", extensionId);

  const formPage = await context.newPage();
  await formPage.goto(testPageUrl);

  const debugPage = await context.newPage();
  await debugPage.goto(`chrome-extension://${extensionId}/debug.html`);
  await debugPage.waitForTimeout(300);

  await debugPage.click("#extract-btn");
  await debugPage.waitForTimeout(300);
  const stateText = await debugPage.textContent("#elements");
  const stateResp = JSON.parse(stateText);
  if (!stateResp.ok) throw new Error("EXTRACT_STATE failed: " + JSON.stringify(stateResp));
  const elements = stateResp.state.elements;
  console.log(`extracted ${elements.length} interactive elements`);

  const byLabel = (label) => elements.find((e) => e.label.toLowerCase().includes(label.toLowerCase()));
  const fields = {
    "Full Name": "Asha Verma",
    Email: "asha.verma@example.com",
    "Phone Number": "9876543210",
    Aadhaar: "234123412346",
    PAN: "ABCDE1234F",
    Address: "12 MG Road, Bengaluru",
  };

  for (const [label, value] of Object.entries(fields)) {
    const el = byLabel(label);
    if (!el) throw new Error(`no element found for label "${label}"`);
    await debugPage.fill("#target-id", String(el.target_id));
    await debugPage.fill("#action-value", value);
    await debugPage.selectOption("#action-type", "type");
    await debugPage.click("#execute-btn");
    await debugPage.waitForTimeout(150);
    const res = JSON.parse(await debugPage.textContent("#exec-result"));
    if (!res.ok || !res.result.success) throw new Error(`type into "${label}" failed: ${JSON.stringify(res)}`);
  }

  const deptEl = byLabel("Department");
  await debugPage.fill("#target-id", String(deptEl.target_id));
  await debugPage.fill("#action-value", "engineering");
  await debugPage.selectOption("#action-type", "type");
  await debugPage.click("#execute-btn");
  await debugPage.waitForTimeout(150);

  const submitEl = elements.find((e) => e.role === "button" && e.type === "submit");
  if (!submitEl) throw new Error("no submit button found");
  await debugPage.fill("#target-id", String(submitEl.target_id));
  await debugPage.selectOption("#action-type", "click");
  await debugPage.click("#execute-btn");
  await debugPage.waitForTimeout(200);

  const resultText = await formPage.textContent("#result");
  console.log("form result:", resultText);

  const checks = [
    resultText.includes("Asha Verma"),
    resultText.includes("asha.verma@example.com"),
    resultText.includes("9876543210"),
    resultText.includes("234123412346"),
    resultText.includes("ABCDE1234F"),
    resultText.includes("engineering"),
  ];
  if (checks.some((c) => !c)) {
    throw new Error("submitted form data did not match expected values: " + resultText);
  }

  console.log("PHASE 1 SMOKE TEST: PASS");
  await context.close();
  server.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

main().catch((e) => {
  console.error("PHASE 1 SMOKE TEST: FAIL");
  console.error(e);
  process.exit(1);
});

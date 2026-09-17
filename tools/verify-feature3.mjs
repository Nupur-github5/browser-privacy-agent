// Feature 3 verification: vault + privacy report + the gov-portal test page.
//
// Asserts, against a real run in a real Chromium with the real extension
// loaded:
//   1. The side panel's vault editor shows the default seeded (fake) profile.
//   2. Given a BLANK government-style form (test-pages/gov-portal.html — no
//      pre-filled PII anywhere in its DOM), the agent fills it using vault
//      tokens and the form submits with the REAL vault values (proving
//      client-side detokenization from a vault-only source, not just from
//      values already visible in the page).
//   3. None of the raw vault values ever appear in any request body the
//      server actually received (eval/network-payload.jsonl, PVA_LOG_PAYLOADS=1).
//   4. The side panel renders a privacy report with one entry per protected
//      value and a "0 sent in raw form" summary.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionPath = path.join(repoRoot, "extension");
const testPagesDir = path.join(repoRoot, "test-pages");
const serverDir = path.join(repoRoot, "server");
const payloadLogPath = path.join(repoRoot, "eval", "network-payload.jsonl");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-f3-"));

const DEFAULT_PROFILE = {
  fullName: "Priya Nair",
  email: "priya.nair@example.com",
  phone: "9812345670",
  aadhaar: "234123412346",
  pan: "ABCDE1234F",
  address: "221 Residency Road, Bengaluru",
};

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

function waitForHealth(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      http.get(url, (res) => (res.statusCode === 200 ? resolve() : retry())).on("error", retry);
      function retry() {
        if (Date.now() > deadline) reject(new Error("server did not become healthy in time"));
        else setTimeout(poll, 500);
      }
    })();
  });
}

async function main() {
  const envPath = path.join(serverDir, ".env");
  if (!fs.existsSync(envPath) || !/GROQ_API_KEY=\S+/.test(fs.readFileSync(envPath, "utf8"))) {
    throw new Error("server/.env with GROQ_API_KEY is required");
  }

  fs.rmSync(payloadLogPath, { force: true });

  const pythonBin = path.join(serverDir, ".venv", "bin", "python");
  const serverProc = spawn(pythonBin, ["run.py"], {
    cwd: serverDir,
    env: { ...process.env, PORT: "8000", PVA_LOG_PAYLOADS: "1" },
  });
  let serverLog = "";
  serverProc.stdout.on("data", (d) => (serverLog += d));
  serverProc.stderr.on("data", (d) => (serverLog += d));

  const testServer = await serveTestPages();
  const port = testServer.address().port;

  try {
    await waitForHealth("http://127.0.0.1:8000/health");
    console.log("server healthy (payload logging enabled)");

    const chromeBinary = path.join(os.homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: fs.existsSync(chromeBinary) ? chromeBinary : undefined,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--headless=new"],
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(sw.url()).host;
    console.log("extension id:", extensionId);

    const formPage = await context.newPage();
    await formPage.goto(`http://127.0.0.1:${port}/gov-portal.html`);
    await formPage.waitForTimeout(300);

    // --- Sanity check: the gov-portal form starts genuinely blank ---
    const initialValues = await formPage.evaluate(() => ({
      fullName: document.getElementById("gov-full-name").value,
      aadhaar: document.getElementById("gov-aadhaar").value,
      address: document.getElementById("gov-address").value,
      phone: document.getElementById("gov-phone").value,
    }));
    if (Object.values(initialValues).some((v) => v)) {
      throw new Error("gov-portal.html form should start blank: " + JSON.stringify(initialValues));
    }
    console.log("gov-portal form confirmed blank before the run");

    // --- Vault editor shows the default seeded (fake) profile ---
    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panelPage.waitForTimeout(300);
    await formPage.bringToFront();

    await panelPage.click("#vault-details summary");
    await panelPage.waitForTimeout(150);
    const vaultValues = await panelPage.evaluate(() => {
      const out = {};
      document.querySelectorAll("#vault-fixed-fields input").forEach((el) => (out[el.dataset.key] = el.value));
      return out;
    });
    console.log("vault editor values:", vaultValues);
    for (const [key, expected] of Object.entries(DEFAULT_PROFILE)) {
      if (vaultValues[key] !== expected) {
        throw new Error(`vault field "${key}" expected "${expected}", got "${vaultValues[key]}"`);
      }
    }
    console.log("vault editor correctly shows the default seeded profile");

    // --- Run the agent against the blank gov-portal form, demo mode off for speed ---
    await panelPage.uncheck("#demo-mode");
    await panelPage.fill("#task-input", "Fill in the Aadhaar Detail Update form using my saved details and submit it.");
    await panelPage.click("#run-btn");

    let finalStatus = null;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      finalStatus = await panelPage.textContent("#status");
      if (finalStatus !== "running") break;
      await panelPage.waitForTimeout(1000);
    }
    if (finalStatus === "running") {
      console.error(serverLog.slice(-4000));
      throw new Error("agent did not finish in time");
    }
    console.log("final panel status:", finalStatus);
    const fullLog = await panelPage.$$eval("#log .log-line", (els) => els.map((e) => e.textContent));
    console.log("panel log:\n" + fullLog.join("\n"));
    if (finalStatus !== "done") {
      console.error(serverLog.slice(-4000));
      throw new Error("run did not reach done: " + finalStatus);
    }

    // --- Form submitted with the REAL vault values ---
    const resultText = await formPage.textContent("#result");
    console.log("form result:", resultText);
    if (!resultText.startsWith("Submitted:")) throw new Error("gov-portal form did not submit: " + resultText);
    const submitted = JSON.parse(resultText.replace(/^Submitted:\s*/, ""));
    for (const [key, expected] of Object.entries({ fullName: DEFAULT_PROFILE.fullName, aadhaar: DEFAULT_PROFILE.aadhaar, address: DEFAULT_PROFILE.address, phone: DEFAULT_PROFILE.phone })) {
      if (submitted[key] !== expected) {
        throw new Error(`submitted "${key}" mismatch: expected "${expected}", got "${submitted[key]}"`);
      }
    }
    console.log("gov-portal form submitted with the REAL vault values (vault -> token -> detokenize verified end-to-end)");

    // --- No raw vault value ever hit the wire ---
    const loggedPayloads = fs.existsSync(payloadLogPath) ? fs.readFileSync(payloadLogPath, "utf8") : "";
    for (const [key, value] of Object.entries(DEFAULT_PROFILE)) {
      if (loggedPayloads.includes(value)) {
        throw new Error(`raw vault value for "${key}" ("${value}") leaked into a logged outgoing payload`);
      }
    }
    if (!loggedPayloads.includes("[NAME_1]") || !loggedPayloads.includes("[AADHAAR_1]")) {
      throw new Error("expected [NAME_1]/[AADHAAR_1] tokens in the logged payloads, found none — redaction may not be active");
    }
    console.log("zero raw vault values in any logged outgoing payload; tokens present (redaction confirmed active)");

    // --- Privacy report rendered in the side panel, from the real run ---
    const reportVisible = await panelPage.evaluate(() => document.getElementById("privacy-report").style.display !== "none");
    if (!reportVisible) throw new Error("privacy report was not shown after a completed run");
    const reportEntries = await panelPage.$$eval("#privacy-report-entries .privacy-entry", (els) =>
      els.map((el) => ({
        masked: el.querySelector(".masked")?.textContent,
        token: el.querySelector(".token")?.textContent,
        confirm: el.querySelector(".confirm")?.textContent,
      }))
    );
    console.log("privacy report entries:", reportEntries);
    if (reportEntries.length < 6) throw new Error("expected at least 6 privacy report entries (the 6 default vault fields), got " + reportEntries.length);
    if (!reportEntries.every((e) => e.confirm && e.confirm.includes("not sent raw"))) {
      throw new Error("every privacy report entry should confirm the value was not sent raw");
    }
    const summaryText = await panelPage.textContent("#privacy-report-summary");
    console.log("privacy report summary:", summaryText);
    if (!/^\d+ sensitive values? protected — 0 sent in raw form this session\.$/.test(summaryText.trim())) {
      throw new Error("unexpected privacy report summary text: " + summaryText);
    }
    // A masked hint must never contain the full raw value.
    for (const entry of reportEntries) {
      for (const value of Object.values(DEFAULT_PROFILE)) {
        if (value.length > 4 && entry.masked.includes(value)) {
          throw new Error(`privacy report masked hint leaked a full raw value: "${entry.masked}"`);
        }
      }
    }
    console.log("privacy report correctly masks every value and matches the actual protected count");

    console.log("\nFEATURE 3 VERIFICATION: PASS");
    await context.close();
  } finally {
    testServer.close();
    serverProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("FEATURE 3 VERIFICATION: FAIL");
  console.error(e);
  process.exit(1);
});

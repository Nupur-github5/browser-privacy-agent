// The Phase 7 scripted demo: a new-hire "profile autofill" scenario covering
// all six PII types named in the brief — name, email, phone, Aadhaar, PAN,
// address. The agent reads a pre-filled "saved profile" and copies it into
// an empty application form, using only tokens it's given (never real
// values), then submits. Afterwards this script proves — by inspecting the
// exact payloads the server received — that not one raw PII value ever left
// the browser, while the submitted form shows the real values were used.
//
// Run: node tools/demo.mjs   (needs server/.env with a working GROQ_API_KEY)
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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-demo-"));

const PROFILE = {
  name: "Priya Nair",
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
      http
        .get(url, (res) => (res.statusCode === 200 ? resolve() : retry()))
        .on("error", retry);
      function retry() {
        if (Date.now() > deadline) reject(new Error("server did not become healthy in time"));
        else setTimeout(poll, 500);
      }
    })();
  });
}

function banner(title) {
  console.log();
  console.log("=".repeat(70));
  console.log(title);
  console.log("=".repeat(70));
}

async function main() {
  const envPath = path.join(serverDir, ".env");
  if (!fs.existsSync(envPath) || !/GROQ_API_KEY=\S+/.test(fs.readFileSync(envPath, "utf8"))) {
    throw new Error("server/.env with GROQ_API_KEY is required — copy server/.env.example and fill it in");
  }

  fs.rmSync(payloadLogPath, { force: true });

  banner("Privacy-Preserving Vision Agent — Live Demo");
  console.log("Scenario: autofill a job application from a saved profile containing");
  console.log("name, email, phone, Aadhaar, PAN, and address — the agent only ever");
  console.log("sees tokens, never the real values.");

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
  const testPageUrl = `http://127.0.0.1:${port}/demo.html`;

  try {
    await waitForHealth("http://127.0.0.1:8000/health");
    console.log("\n[1/5] Server started, real Groq LLM calls enabled, payload logging on.");

    const chromeBinary = path.join(os.homedir(), ".cache/ms-playwright/chromium-1234/chrome-linux64/chrome");
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: true,
      executablePath: fs.existsSync(chromeBinary) ? chromeBinary : undefined,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, "--headless=new"],
    });

    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 10000 });
    const extensionId = new URL(sw.url()).host;

    const formPage = await context.newPage();
    await formPage.goto(testPageUrl);
    console.log("[2/5] Extension loaded, application form open (all fields empty).");

    const debugPage = await context.newPage();
    await debugPage.goto(`chrome-extension://${extensionId}/debug.html`);
    await debugPage.waitForTimeout(300);

    await debugPage.click("#extract-btn");
    await debugPage.waitForTimeout(300);
    const stateResp = JSON.parse(await debugPage.textContent("#elements"));
    if (!stateResp.ok) throw new Error("EXTRACT_STATE failed: " + JSON.stringify(stateResp));
    console.log(`[3/5] Local extraction + PII detection ran in the browser.`);
    console.log(`      ${stateResp.state.available_tokens.length} PII values tokenized: ${stateResp.state.available_tokens.join(", ")}`);
    for (const raw of Object.values(PROFILE)) {
      const leaked = JSON.stringify(stateResp.state.elements).includes(raw);
      if (leaked) throw new Error(`PRIVACY VIOLATION: raw value "${raw}" present in extracted state`);
    }
    console.log("      Confirmed: zero raw PII values in the extracted state.");

    await debugPage.fill(
      "#task-input",
      "Fill out the application form on the right using the saved profile information on the left, then submit the form."
    );
    await debugPage.click("#run-task-btn");
    console.log("\n[4/5] Agent running (server sees only tokens; each type action is");
    console.log("      detokenized locally right before it's typed into the DOM)...");

    let taskResult = null;
    const deadline = Date.now() + 150000;
    while (Date.now() < deadline) {
      const text = await debugPage.textContent("#task-result");
      if (text && text !== "running..." && text !== "(agent not run yet)") {
        try {
          taskResult = JSON.parse(text);
        } catch {
          // transient
        }
        if (taskResult) break;
      }
      await debugPage.waitForTimeout(1000);
    }
    if (!taskResult) {
      console.error(serverLog.slice(-4000));
      throw new Error("agent did not finish in time");
    }
    if (!taskResult.ok || !taskResult.done) {
      throw new Error("agent did not complete the task: " + JSON.stringify(taskResult));
    }
    console.log(`      Agent finished in ${taskResult.steps.length} steps: "${taskResult.reason}"`);

    const resultText = await formPage.textContent("#result");
    if (!resultText.startsWith("Submitted:")) throw new Error("form was not submitted: " + resultText);
    const submitted = JSON.parse(resultText.replace(/^Submitted:\s*/, ""));

    console.log("\n[5/5] Form submitted. Verifying the REAL values landed correctly:");
    let allCorrect = true;
    const fieldMap = { fullName: "name", email: "email", phone: "phone", aadhaar: "aadhaar", pan: "pan", address: "address" };
    for (const [formField, profileKey] of Object.entries(fieldMap)) {
      const ok = submitted[formField] === PROFILE[profileKey];
      console.log(`      ${formField.padEnd(10)} ${ok ? "correct" : "MISMATCH"}: "${submitted[formField]}"`);
      if (!ok) allCorrect = false;
    }
    if (!allCorrect) throw new Error("one or more fields did not match the saved profile after detokenization");

    banner("Privacy Proof");
    const loggedLines = fs.readFileSync(payloadLogPath, "utf8").trim().split("\n").filter(Boolean);
    const fullLogText = loggedLines.join("\n");
    console.log(`Inspected ${loggedLines.length} outgoing /agent/step request(s) actually received by the server.`);
    for (const [field, raw] of Object.entries(PROFILE)) {
      if (fullLogText.includes(raw)) {
        throw new Error(`PRIVACY VIOLATION: raw ${field} value "${raw}" found in network-payload.jsonl`);
      }
    }
    console.log("Zero raw PII values found in any payload sent to the server. Confirmed tokens present:");
    for (const token of stateResp.state.available_tokens) {
      console.log(`  ${token}: ${fullLogText.includes(token) ? "present" : "MISSING"}`);
    }
    console.log(`\nFull proof log: ${payloadLogPath}`);

    banner("DEMO COMPLETE — all six PII values redacted before leaving the browser,");
    console.log("form submitted correctly with the real values via local detokenization.");

    await context.close();
  } finally {
    testServer.close();
    serverProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("\nDEMO FAILED:", e.message);
  process.exit(1);
});

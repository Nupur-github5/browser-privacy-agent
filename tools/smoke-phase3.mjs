// Phase 3 smoke test: proves the privacy invariant end-to-end.
//
// Loads a page pre-filled with real PII (name/email/phone/Aadhaar/PAN/
// address), asks the agent to copy the Aadhaar number into a "Confirm
// Aadhaar" field and submit. The server logs every /agent/step request body
// it actually receives (PVA_LOG_PAYLOADS=1) to eval/network-payload.jsonl.
// This script asserts:
//   1. none of the raw PII values ever appear in any logged request body
//   2. the corresponding [TOKEN_N] placeholders DO appear (proving
//      redaction happened, not just accidental omission)
//   3. the form still submits with the REAL Aadhaar value in both fields
//      (proving client-side detokenization worked before typing)
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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-smoke3-"));

const RAW_PII = {
  name: "Asha Verma",
  email: "asha.verma@example.com",
  phone: "9876543210",
  aadhaar: "234123412346",
  pan: "ABCDE1234F",
  address: "12 MG Road",
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
        .get(url, (res) => {
          if (res.statusCode === 200) resolve();
          else retry();
        })
        .on("error", retry);
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
  const testPageUrl = `http://127.0.0.1:${port}/pii-review.html`;

  try {
    await waitForHealth("http://127.0.0.1:8000/health");
    console.log("server healthy (payload logging enabled)");

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

    // Sanity check: the extractor/detector must tokenize the pre-filled PII.
    await debugPage.click("#extract-btn");
    await debugPage.waitForTimeout(300);
    const stateResp = JSON.parse(await debugPage.textContent("#elements"));
    if (!stateResp.ok) throw new Error("EXTRACT_STATE failed: " + JSON.stringify(stateResp));
    console.log("available_tokens:", stateResp.state.available_tokens);
    for (const el of stateResp.state.elements) {
      for (const raw of Object.values(RAW_PII)) {
        if (typeof el.value === "string" && el.value.includes(raw)) {
          throw new Error(`raw PII "${raw}" leaked into extracted state element: ${JSON.stringify(el)}`);
        }
      }
    }
    if (stateResp.state.available_tokens.length < 5) {
      throw new Error("expected at least 5 PII tokens from the pre-filled fields, got: " + JSON.stringify(stateResp.state.available_tokens));
    }

    await debugPage.fill(
      "#task-input",
      "Copy the Aadhaar number into the Confirm Aadhaar Number field, then submit the form."
    );
    await debugPage.click("#run-task-btn");

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
    console.log("agent result:", JSON.stringify(taskResult, null, 2));
    if (!taskResult.ok || !taskResult.done) {
      throw new Error("agent did not complete: " + JSON.stringify(taskResult));
    }

    const resultText = await formPage.textContent("#result");
    console.log("form result:", resultText);
    const submitted = JSON.parse(resultText.replace(/^Submitted:\s*/, ""));
    if (submitted.aadhaar !== RAW_PII.aadhaar) {
      throw new Error(`aadhaar field mismatch: expected ${RAW_PII.aadhaar}, got ${submitted.aadhaar}`);
    }
    if (submitted.confirmAadhaar !== RAW_PII.aadhaar) {
      throw new Error(
        `confirmAadhaar was not correctly detokenized: expected ${RAW_PII.aadhaar}, got "${submitted.confirmAadhaar}"`
      );
    }
    console.log("form submitted with correct REAL Aadhaar value in both fields (detokenization verified)");

    // --- The core privacy proof: inspect exactly what the server received ---
    if (!fs.existsSync(payloadLogPath)) {
      throw new Error("no network-payload.jsonl was written — server-side logging did not fire");
    }
    const loggedLines = fs.readFileSync(payloadLogPath, "utf8").trim().split("\n").filter(Boolean);
    if (loggedLines.length === 0) throw new Error("network-payload.jsonl is empty");
    const fullLogText = loggedLines.join("\n");

    console.log(`inspecting ${loggedLines.length} logged /agent/step request(s) for raw PII...`);
    for (const [field, raw] of Object.entries(RAW_PII)) {
      if (fullLogText.includes(raw)) {
        throw new Error(`PRIVACY VIOLATION: raw ${field} value "${raw}" found in network-payload.jsonl`);
      }
    }
    console.log("confirmed: zero raw PII values found in any logged outgoing payload");

    if (!fullLogText.includes("[AADHAAR_1]")) {
      throw new Error("expected [AADHAAR_1] token to appear in logged payloads — redaction may not have run");
    }
    console.log("confirmed: [AADHAAR_1] token present in logged payloads (redaction is active, not just absent data)");

    console.log(`privacy proof written to: ${payloadLogPath}`);
    console.log("PHASE 3 SMOKE TEST: PASS");
    await context.close();
  } finally {
    testServer.close();
    serverProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("PHASE 3 SMOKE TEST: FAIL");
  console.error(e);
  process.exit(1);
});

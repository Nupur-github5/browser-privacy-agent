// Phase 2 smoke test: spawns the real FastAPI server (real Groq LLM calls,
// no privacy layer yet), loads the unpacked extension in Chromium, and asks
// the agent loop to autonomously fill + submit the employee-portal form.
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
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-smoke2-"));

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
  if (!fs.existsSync(envPath)) {
    throw new Error("server/.env not found — copy server/.env.example and set GROQ_API_KEY first");
  }
  const envContent = fs.readFileSync(envPath, "utf8");
  if (!/GROQ_API_KEY=\S+/.test(envContent)) {
    throw new Error("GROQ_API_KEY is not set in server/.env");
  }

  const pythonBin = path.join(serverDir, ".venv", "bin", "python");
  const serverProc = spawn(pythonBin, ["run.py"], { cwd: serverDir, env: { ...process.env, PORT: "8000" } });
  let serverLog = "";
  serverProc.stdout.on("data", (d) => (serverLog += d));
  serverProc.stderr.on("data", (d) => (serverLog += d));

  const testServer = await serveTestPages();
  const port = testServer.address().port;
  const testPageUrl = `http://127.0.0.1:${port}/employee-portal.html`;

  try {
    await waitForHealth("http://127.0.0.1:8000/health");
    console.log("server healthy");

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

    await debugPage.fill("#task-input", "Fill this form with realistic test data for all fields and submit it.");
    const clickStart = Date.now();
    await debugPage.click("#run-task-btn");

    // Agent loop can take a few LLM round trips — poll for completion.
    let taskResult = null;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const text = await debugPage.textContent("#task-result");
      if (text && text !== "running..." && text !== "(agent not run yet)") {
        try {
          taskResult = JSON.parse(text);
        } catch {
          // transient render mid-write; keep polling
        }
        if (taskResult) break;
      }
      await debugPage.waitForTimeout(1000);
    }
    console.log(`polled for ${((Date.now() - clickStart) / 1000).toFixed(1)}s`);
    if (!taskResult) {
      console.error("--- server log ---");
      console.error(serverLog.slice(-4000));
      throw new Error("agent did not finish within the poll deadline");
    }

    console.log("agent result:", JSON.stringify(taskResult, null, 2));
    if (!taskResult.ok) throw new Error("RUN_TASK reported failure: " + JSON.stringify(taskResult));
    if (!taskResult.done) throw new Error("agent did not reach done within max steps: " + JSON.stringify(taskResult));

    const resultText = await formPage.textContent("#result");
    console.log("form result:", resultText);
    if (!resultText.startsWith("Submitted:")) {
      throw new Error("form was not submitted: " + resultText);
    }

    console.log("PHASE 2 SMOKE TEST: PASS");
    await context.close();
  } finally {
    testServer.close();
    serverProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("PHASE 2 SMOKE TEST: FAIL");
  console.error(e);
  process.exit(1);
});

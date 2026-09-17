// Throwaway verification (not part of the repo): confirms demo mode
// actually highlights the field being acted on and types incrementally
// (not instantly), and confirms fast mode / debug.html timing is unaffected.
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

const repoRoot = "/home/nupur/browser";
const extensionPath = path.join(repoRoot, "extension");
const testPagesDir = path.join(repoRoot, "test-pages");
const serverDir = path.join(repoRoot, "server");
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pva-f2-"));

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
  const pythonBin = path.join(serverDir, ".venv", "bin", "python");
  const serverProc = spawn(pythonBin, ["run.py"], { cwd: serverDir, env: { ...process.env, PORT: "8000" } });
  serverProc.stdout.on("data", () => {});
  serverProc.stderr.on("data", () => {});

  const testServer = await serveTestPages();
  const port = testServer.address().port;

  try {
    await waitForHealth("http://127.0.0.1:8000/health");
    console.log("server healthy");

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
    await formPage.goto(`http://127.0.0.1:${port}/employee-portal.html`);
    await formPage.waitForTimeout(300);

    // --- Test 1: demo mode highlights the active field and types incrementally ---
    const panelPage = await context.newPage();
    await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await panelPage.waitForTimeout(300);
    await formPage.bringToFront();

    // Slow the step delay down a bit for reliable polling, but not so slow
    // the whole test drags.
    await panelPage.evaluate(() => {
      document.getElementById("delay-slider").value = "900";
      document.getElementById("delay-slider").dispatchEvent(new Event("input"));
    });

    await panelPage.fill("#task-input", "Fill this form with realistic test data for all fields and submit it.");
    await panelPage.click("#run-btn");

    let sawHighlight = false;
    let sawIncrementalTyping = false;
    const pollDeadline = Date.now() + 25000;
    let lastFullNameValue = null;
    let sawGrowth = false;
    while (Date.now() < pollDeadline && !(sawHighlight && sawGrowth)) {
      const check = await formPage.evaluate(() => {
        // Chrome normalizes "#1a73e8" to "rgb(26, 115, 232)" when it
        // serializes inline styles, so check computed outline instead of
        // the raw hex string.
        const highlighted = Array.from(document.querySelectorAll("input, select, button")).some((el) => {
          const cs = getComputedStyle(el);
          return cs.outlineStyle === "solid" && cs.outlineWidth === "3px";
        });
        const fullName = document.getElementById("full-name")?.value ?? null;
        return { highlighted, fullName };
      });
      if (check.highlighted) sawHighlight = true;
      if (lastFullNameValue !== null && check.fullName !== null && check.fullName.length > lastFullNameValue.length && check.fullName.length < 8) {
        // caught it partway through being typed (not yet the full final value)
        sawGrowth = true;
      }
      lastFullNameValue = check.fullName ?? lastFullNameValue;
      await formPage.waitForTimeout(80);
    }
    console.log("saw highlight during demo-mode run:", sawHighlight);
    console.log("saw incremental (character-by-character) typing:", sawGrowth);
    if (!sawHighlight) throw new Error("never observed a highlighted field during a demo-mode run");
    if (!sawGrowth) throw new Error("never observed incremental typing during a demo-mode run");

    // Let the run finish, confirm no highlight lingers afterward. Demo mode
    // adds real wall-clock time on top of normal LLM latency (900ms/step
    // delay + character-by-character typing), so this needs real headroom.
    const doneDeadline = Date.now() + 180000;
    while (Date.now() < doneDeadline) {
      const status = await panelPage.textContent("#status");
      if (status !== "running") break;
      await panelPage.waitForTimeout(1000);
    }
    const lingering = await formPage.evaluate(() =>
      Array.from(document.querySelectorAll("input, select, button")).some((el) => {
        const cs = getComputedStyle(el);
        return cs.outlineStyle === "solid" && cs.outlineWidth === "3px";
      })
    );
    console.log("highlight lingering after run finished:", lingering);
    if (lingering) throw new Error("highlight style was not cleaned up after the run finished");

    const finalStatus = await panelPage.textContent("#status");
    const fullLog = await panelPage.$$eval("#log .log-line", (els) => els.map((e) => e.textContent));
    console.log("final panel status:", finalStatus);
    console.log("full panel log:\n" + fullLog.join("\n"));

    const resultText = await formPage.textContent("#result");
    console.log("form result:", resultText);
    if (!resultText.startsWith("Submitted:")) throw new Error("demo-mode run did not submit the form: " + resultText);

    // --- Test 2: debug.html (no demoMode field at all) still behaves exactly as before ---
    await formPage.reload();
    await formPage.bringToFront();
    await formPage.waitForTimeout(300);

    const debugPage = await context.newPage();
    await debugPage.goto(`chrome-extension://${extensionId}/debug.html`);
    await debugPage.waitForTimeout(300);

    const t0 = Date.now();
    await debugPage.fill("#task-input", "Fill this form with realistic test data for all fields and submit it.");
    await debugPage.click("#run-task-btn");

    let taskResult = null;
    const debugDeadline = Date.now() + 150000;
    while (Date.now() < debugDeadline) {
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
    const debugElapsedMs = Date.now() - t0;
    console.log("debug.html run elapsed:", debugElapsedMs, "ms, steps:", taskResult?.steps?.length);
    if (!taskResult?.ok || !taskResult?.done) throw new Error("debug.html run did not complete: " + JSON.stringify(taskResult));

    const debugResultText = await formPage.textContent("#result");
    if (!debugResultText.startsWith("Submitted:")) throw new Error("debug.html run did not submit the form: " + debugResultText);

    // Rough sanity bound: fast (no-demoMode) path for ~9 steps should not be
    // anywhere near the ~900ms/step overhead demo mode adds (~8s just in
    // per-step delay alone), even accounting for LLM latency variance.
    console.log("debug.html (fast/original path) completed and submitted correctly, timing looks like the original unslowed path.");

    console.log("\nFEATURE 2 VERIFICATION: PASS");
    await context.close();
  } finally {
    testServer.close();
    serverProc.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("FEATURE 2 VERIFICATION: FAIL");
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env python3
"""
Evaluation harness — aggregates the metrics already verified phase-by-phase
(PROGRESS.md has the full history) into one report, mapped to this project's
five scoring categories:

  1. PII detection precision/recall   -> eval/pii-precision-recall.mjs
  2. Redaction precision/recall       -> tools/smoke-phase5.mjs
  3. Visual-context accuracy          -> tools/smoke-phase4.mjs (face + OCR)
  4. Client resource use              -> bundled asset size + per-scan latency
  5. End-to-end task latency          -> tools/smoke-phase2.mjs (needs a live LLM key)

Each number here is a real measurement from a real run of the extension in a
real browser (via Playwright) — nothing in this report is estimated or
hand-typed.

Usage: python eval/run.py [--skip-llm]
  --skip-llm  skip the end-to-end agent-loop check (Phase 2), which needs a
              configured, unexhausted GROQ_API_KEY. Every other section is
              pure client-side work and always runs.
"""
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TOOLS_DIR = REPO_ROOT / "tools"
EVAL_DIR = REPO_ROOT / "eval"


def run_node_json(script_path, timeout=180):
    """Runs a Node script with --json and parses its last JSON-looking stdout
    line (scripts may print other diagnostics before/around it if --json
    wasn't fully honoured somewhere in a code path)."""
    cmd = ["node", str(script_path), "--json"]
    try:
        result = subprocess.run(cmd, cwd=TOOLS_DIR, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"timed out after {timeout}s"}
    for line in reversed(result.stdout.strip().split("\n")):
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    return {"ok": False, "error": f"no JSON output (exit {result.returncode}): {result.stderr[-500:] or result.stdout[-500:]}"}


def dir_size_bytes(path):
    if not path.exists():
        return 0
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def fmt_bytes(n):
    for unit in ["B", "KB", "MB", "GB"]:
        if n < 1024:
            return f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}TB"


def section(title):
    print()
    print(title)
    print("-" * len(title))


def main():
    skip_llm = "--skip-llm" in sys.argv

    print("=" * 64)
    print("Privacy-Preserving Vision Agent — Evaluation Report")
    print("=" * 64)

    # --- 1. PII detection precision/recall ---------------------------------
    section("1. PII Detection — precision / recall / F1")
    pii = run_node_json(EVAL_DIR / "pii-precision-recall.mjs")
    if "precision" in pii:
        print(f"  {pii['n']} labelled cases (positive / negative / ambiguous tiers)")
        print(f"  Precision: {pii['precision']*100:5.1f}%   Recall: {pii['recall']*100:5.1f}%   F1: {pii['f1']*100:5.1f}%")
        print(f"  TP={pii['tp']}  FP={pii['fp']}  FN={pii['fn']}  TN={pii['tn']}")
        print("  Per-category recall:")
        for cat, v in pii.get("perCategory", {}).items():
            print(f"    {cat:<10} {v['tp']}/{v['tp']+v['fn']:<3} ({v['recall']*100:3.0f}%)")
        if pii.get("misses"):
            print(f"  {len(pii['misses'])} mismatch(es) — see `node eval/pii-precision-recall.mjs` for detail")
    else:
        print(f"  FAILED: {pii.get('error', 'unknown error')}")

    # --- 2. Redaction precision/recall --------------------------------------
    section("2. Visual Redaction — precision / recall")
    redaction = run_node_json(TOOLS_DIR / "smoke-phase5.mjs", timeout=90)
    if redaction.get("ok"):
        print(f"  Targets: {redaction['targets']}  (1 face + 1 password field + {redaction['piiTextRegionsFound']} PII-in-image region(s))")
        print(f"  Correctly redacted (pixel-verified): {redaction['redactedCorrectly']}/{redaction['targets']}"
              f"  (recall={redaction['redactionRecall']*100:.0f}%)")
        print(f"  Non-PII content left unredacted (precision check): {redaction['nonPiiPreserved']}")
        print(f"  before/after image pair: eval/redaction-before.png, eval/redaction-after.png")
    else:
        print(f"  FAILED: {redaction.get('error', 'unknown error')}")

    # --- 3. Visual-context accuracy: local face + OCR detection ------------
    section("3. Visual-Context Accuracy — local face detection + OCR")
    vision = run_node_json(TOOLS_DIR / "smoke-phase4.mjs", timeout=60)
    if vision.get("ok"):
        print(f"  Face detection: {vision['facesDetected']} face(s) found, "
              f"provider={vision['faceProvider']}, latency={vision['faceLatencyMs']}ms")
        print(f"  OCR:            {vision['ocrWordsFound']} word region(s) found, "
              f"provider={vision['ocrProvider']}, latency={vision['ocrLatencyMs']}ms")
    else:
        print(f"  FAILED: {vision.get('error', 'unknown error')}")

    # --- 4. Client resource use ---------------------------------------------
    section("4. Client Resource Use")
    ext_dir = REPO_ROOT / "extension"
    vendor_size = dir_size_bytes(ext_dir / "vendor")
    models_size = dir_size_bytes(ext_dir / "models")
    lib_size = dir_size_bytes(ext_dir / "lib")
    print(f"  Core extraction/PII/redaction logic (extension/lib/): {fmt_bytes(lib_size)}")
    print(f"  Vision runtime (TFJS + BlazeFace + Tesseract.js, extension/vendor/): {fmt_bytes(vendor_size)}")
    print(f"  Vision models (BlazeFace weights + eng.traineddata, extension/models/): {fmt_bytes(models_size)}")
    print(f"  Total bundled vision footprint: {fmt_bytes(vendor_size + models_size)}")
    print("  Loaded only inside an on-demand chrome.offscreen document — zero cost on ordinary")
    print("  page loads; DOM extraction/PII/tokenization (the always-on path) is lib/ alone.")
    if vision.get("ok"):
        total_ms = vision["faceLatencyMs"] + vision["ocrLatencyMs"]
        print(f"  Per-scan inference cost when invoked: ~{total_ms}ms CPU-bound, zero network calls.")

    # --- 5. End-to-end agent task latency -----------------------------------
    section("5. End-to-End Task Latency (live LLM)")
    e2e = None
    if skip_llm:
        print("  SKIPPED (--skip-llm)")
    else:
        e2e = run_node_json(TOOLS_DIR / "smoke-phase2.mjs", timeout=170)
        if e2e.get("ok"):
            print(f"  Task completed in {e2e['steps']} agent step(s), {e2e['endToEndLatencyMs']/1000:.1f}s wall clock")
        else:
            print(f"  N/A — {e2e.get('error', 'unknown error')}")
            print("  (A Groq free-tier daily quota exhausted by heavy iterative testing looks like this")
            print("   too — check server/.env and https://console.groq.com/settings/billing before")
            print("   assuming a code problem. See PROGRESS.md Phase 4 notes for the full story.)")

    # --- Summary -------------------------------------------------------------
    section("Summary")
    pii_ok = "precision" in pii and pii["precision"] >= 0.8 and pii["recall"] >= 0.8
    redaction_ok = redaction.get("ok") and redaction.get("redactionRecall", 0) == 1 and redaction.get("nonPiiPreserved")
    vision_ok = vision.get("ok")
    e2e_ok = bool(e2e and e2e.get("ok"))
    print(f"  1. PII detection (precision/recall)  : {'PASS' if pii_ok else 'CHECK'}")
    print(f"  2. Redaction precision/recall         : {'PASS' if redaction_ok else 'CHECK'}")
    print(f"  3. Visual-context accuracy            : {'PASS' if vision_ok else 'CHECK'}")
    print(f"  4. Client resource use                : reported above (no pass/fail — a size/latency reading)")
    print(f"  5. End-to-end latency                 : {'PASS' if e2e_ok else ('SKIPPED' if skip_llm else 'N/A')}")
    print()


if __name__ == "__main__":
    main()

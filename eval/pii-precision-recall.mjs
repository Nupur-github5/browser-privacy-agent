// Precision/recall scorer for the client-side PII detector, run against a
// small hand-labelled set (eval/pii_testset.json) covering positive PII,
// negative non-PII, and deliberately ambiguous/adversarial cases.
//
// Usage: node eval/pii-precision-recall.mjs [--json]
const jsonMode = process.argv.includes("--json");

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { classifyElement } = require(path.join(__dirname, "..", "extension", "lib", "pii-detector.js"));

const testsetPath = path.join(__dirname, "pii_testset.json");
const { cases } = JSON.parse(fs.readFileSync(testsetPath, "utf8"));

let tp = 0, fp = 0, fn = 0, tn = 0;
const perCategory = {}; // category -> {tp, fp, fn}
const misses = [];

for (const c of cases) {
  const predicted = classifyElement(c.element);
  const expectedPII = c.expected_pii;
  const predictedPII = predicted.isPII;

  if (expectedPII && predictedPII) tp++;
  else if (!expectedPII && predictedPII) fp++;
  else if (expectedPII && !predictedPII) fn++;
  else tn++;

  if (expectedPII !== predictedPII || (expectedPII && c.expected_category && c.expected_category !== predicted.category)) {
    misses.push({
      tier: c.tier,
      label: c.element.label,
      value: c.element.value,
      expected: { pii: expectedPII, category: c.expected_category ?? null },
      predicted: { pii: predictedPII, category: predicted.category, signal: predicted.signal },
    });
  }

  if (expectedPII) {
    const cat = c.expected_category || "UNKNOWN";
    perCategory[cat] = perCategory[cat] || { tp: 0, fn: 0 };
    if (predictedPII && predicted.category === cat) perCategory[cat].tp++;
    else perCategory[cat].fn++;
  }
}

const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

if (jsonMode) {
  const perCategoryOut = {};
  for (const [cat, { tp, fn }] of Object.entries(perCategory)) {
    perCategoryOut[cat] = { tp, fn, recall: tp + fn === 0 ? 1 : tp / (tp + fn) };
  }
  console.log(JSON.stringify({ n: cases.length, tp, fp, fn, tn, precision, recall, f1, perCategory: perCategoryOut, misses }));
  process.exit(0);
}

console.log(`PII Detector Evaluation — ${cases.length} labelled cases`);
console.log("=".repeat(60));
console.log(`Overall:  TP=${tp}  FP=${fp}  FN=${fn}  TN=${tn}`);
console.log(`Precision: ${(precision * 100).toFixed(1)}%`);
console.log(`Recall:    ${(recall * 100).toFixed(1)}%`);
console.log(`F1:        ${(f1 * 100).toFixed(1)}%`);
console.log();
console.log("Per-category recall (positive cases only):");
for (const [cat, { tp, fn }] of Object.entries(perCategory)) {
  const r = tp + fn === 0 ? 1 : tp / (tp + fn);
  console.log(`  ${cat.padEnd(10)} ${tp}/${tp + fn}  (${(r * 100).toFixed(0)}%)`);
}

if (misses.length) {
  console.log();
  console.log(`Mismatches (${misses.length}):`);
  for (const m of misses) {
    console.log(`  [${m.tier}] "${m.label}"="${m.value}" — expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.predicted)}`);
  }
}

// Runs the P0 spikes inside a real Tauri/WebView2 window without a human
// clicking. The app reads NOOKEDIT_HEADLESS_REPORT on launch, renders the PDF
// benchmark (and optionally the filesystem spike), writes JSON, and exits.
//
// Usage:
//   node scripts/run-headless.mjs                 # uses release build if present
//   node scripts/run-headless.mjs --debug         # force the debug build
//   node scripts/run-headless.mjs --skip-fs       # benchmark only
//
// Build first with: npm run tauri build

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const targetDir = path.join(here, '..', 'src-tauri', 'target');

const forceDebug = process.argv.includes('--debug');
const skipFs = process.argv.includes('--skip-fs');
const timeoutMs = 180_000;

function findExecutable() {
  const candidates = forceDebug
    ? [path.join(targetDir, 'debug', 'nookedit.exe')]
    : [
        path.join(targetDir, 'release', 'nookedit.exe'),
        path.join(targetDir, 'debug', 'nookedit.exe'),
      ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `No NookEdit executable found. Build it first:\n  npm run tauri build\nLooked in:\n  ${candidates.join('\n  ')}`,
  );
}

const exe = findExecutable();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nookedit-headless-'));
const reportPath = path.join(workDir, `report-${stamp}.json`);
const fsRoot = path.join(workDir, 'library');

if (!skipFs) fs.mkdirSync(fsRoot, { recursive: true });

console.log(`Running ${exe}`);
console.log(`Report: ${reportPath}`);

const env = { ...process.env, NOOKEDIT_HEADLESS_REPORT: reportPath };
if (!skipFs) env.NOOKEDIT_HEADLESS_FS_ROOT = fsRoot;

const child = spawn(exe, [], { env, stdio: 'inherit' });

const deadline = Date.now() + timeoutMs;
let exited = false;
child.on('exit', () => {
  exited = true;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

while (!fs.existsSync(reportPath)) {
  if (exited) {
    throw new Error('The app exited without writing a report. Run it with --debug and watch the console.');
  }
  if (Date.now() > deadline) {
    child.kill();
    throw new Error(`Timed out after ${timeoutMs / 1000}s waiting for the report.`);
  }
  await sleep(250);
}

// Let the app flush and quit on its own before we read the file.
await sleep(500);

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
console.log('\n--- report ---');
console.log(JSON.stringify(report, null, 2));

if (report.pdf) {
  const { pages, firstPageMs, totalMs, msPerPage, pagesPerSecond, heapMb } = report.pdf;
  console.log('\n--- summary ---');
  console.log(
    `${pages} pages · first page ${firstPageMs.toFixed(0)} ms · total ${totalMs.toFixed(0)} ms · ` +
      `${msPerPage.toFixed(1)} ms/page · ${pagesPerSecond.toFixed(1)} pages/sec · ` +
      `heap ${heapMb == null ? 'n/a' : `${heapMb.toFixed(1)} MB`}`,
  );
}

if (!skipFs && report.fs) {
  const { hiddenDir, nestedDirs, atomicWrite } = report.fs;
  console.log(
    `fs spike: hiddenDir=${hiddenDir} nestedDirs=${nestedDirs} atomicWrite=${atomicWrite} root=${report.fs.root}`,
  );
}

console.log(`\nTemp workspace: ${workDir}`);

// End-to-end check for the native messaging host.
//
// Builds the release binary, starts it the way Chrome does (a child process
// with the library root in the environment), and speaks the real protocol over
// stdin/stdout: ping, import, list, chunked read, rename, remove, and errors.
//
// Usage:
//   node scripts/check.mjs             # build, then check
//   node scripts/check.mjs --no-build  # use the existing release binary

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hostDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const READ_CHUNK_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function cargoBinary() {
  const name = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  const local = path.join(os.homedir(), '.cargo', 'bin', name);
  if (fs.existsSync(local)) return local;
  return name;
}

function hostBinary() {
  return path.join(
    hostDir,
    'target',
    'release',
    process.platform === 'win32' ? 'nooksuite-host.exe' : 'nooksuite-host',
  );
}

function buildHost() {
  const exe = hostBinary();
  if (process.argv.includes('--no-build') && fs.existsSync(exe)) return exe;

  console.log('Building the host (cargo build --release)...');
  execFileSync(cargoBinary(), ['build', '--release'], {
    cwd: hostDir,
    stdio: 'inherit',
  });

  assert.ok(fs.existsSync(exe), `The build did not produce ${exe}.`);
  return exe;
}

/** A minimal client for Chrome's 4-byte length + JSON framing. */
function createClient(child) {
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      const message = JSON.parse(payload.toString('utf8'));
      const entry = pending.get(message.requestId);
      if (!entry) continue;

      pending.delete(message.requestId);
      clearTimeout(entry.timer);

      if (message.ok) {
        entry.resolve(message);
      } else {
        const error = new Error(message.error?.message ?? 'The host reported an error.');
        error.code = message.error?.code;
        entry.reject(error);
      }
    }
  });

  child.on('exit', (code) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`The host exited with code ${code} before answering.`));
    }
    pending.clear();
  });

  return {
    request(payload) {
      const requestId = ++nextId;

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Timed out waiting for "${payload.op}".`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(requestId, { resolve, reject, timer });

        const body = Buffer.from(JSON.stringify({ requestId, ...payload }), 'utf8');
        const frame = Buffer.alloc(4 + body.length);
        frame.writeUInt32LE(body.length, 0);
        body.copy(frame, 4);
        child.stdin.write(frame);
      });
    },
  };
}

async function main() {
  const exe = buildHost();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nooksuite-host-check-'));
  console.log(`Running ${exe}`);
  console.log(`Library: ${root}`);

  const child = spawn(exe, [], {
    env: { ...process.env, NOOKSUITE_LIBRARY_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  const exited = new Promise((resolve) => child.on('exit', resolve));
  const client = createClient(child);

  try {
    const ping = await client.request({ op: 'ping' });
    assert.equal(ping.library.root, root);
    assert.equal(ping.library.recordCount, 0);
    console.log(
      `ping: version=${ping.hostVersion} protocol=${ping.protocolVersion} ` +
        `library=${ping.library.libraryId}`,
    );

    const payload = Buffer.alloc(READ_CHUNK_BYTES + 321);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = index % 251;
    }

    const imported = await client.request({
      op: 'import',
      name: 'wire-check.bin',
      mediaType: 'application/octet-stream',
      data: payload.toString('base64'),
    });
    const record = imported.record;
    assert.equal(record.size, payload.length);
    assert.equal(record.mediaType, 'application/octet-stream');

    const stored = path.join(root, 'documents', record.id, record.name);
    assert.deepEqual(fs.readFileSync(stored), payload);
    console.log(`import: ${record.id} "${record.name}" ${record.size} bytes`);

    const listed = await client.request({ op: 'list' });
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].id, record.id);
    console.log(`list: ${listed.records.length} record`);

    const chunks = [];
    let offset = 0;

    for (;;) {
      const chunk = await client.request({ op: 'read', id: record.id, offset });
      chunks.push(Buffer.from(chunk.data, 'base64'));
      offset = chunk.nextOffset;
      if (chunk.eof) break;
      assert.ok(chunks.length < 100, 'The read never finished.');
    }

    const reassembled = Buffer.concat(chunks);
    assert.deepEqual(reassembled, payload);
    console.log(`read: ${chunks.length} chunks, ${reassembled.length} bytes, match=true`);

    const renamed = await client.request({
      op: 'rename',
      id: record.id,
      name: 'renamed-check.bin',
    });
    assert.equal(renamed.record.name, 'renamed-check.bin');
    assert.ok(fs.existsSync(path.join(root, 'documents', record.id, 'renamed-check.bin')));
    console.log(`rename: "${renamed.record.name}"`);

    const removed = await client.request({ op: 'remove', id: record.id });
    assert.equal(removed.ok, true);
    assert.ok(!fs.existsSync(path.join(root, 'documents', record.id)));

    const after = await client.request({ op: 'list' });
    assert.equal(after.records.length, 0);
    console.log('remove: folder gone, 0 records');

    let notFound = null;
    try {
      await client.request({ op: 'read', id: 'doc_missing000', offset: 0 });
    } catch (error) {
      notFound = error;
    }
    assert.equal(notFound?.code, 'not_found');

    let badRequest = null;
    try {
      await client.request({ op: 'nope' });
    } catch (error) {
      badRequest = error;
    }
    assert.equal(badRequest?.code, 'bad_request');
    console.log('errors: not_found and bad_request reported');

    const libraryFile = JSON.parse(
      fs.readFileSync(path.join(root, '.nooksuite', 'library.json'), 'utf8'),
    );
    assert.equal(libraryFile.schemaVersion, 1);
    console.log('index: library.json is valid');
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    await exited;
    clearTimeout(timer);
    fs.rmSync(root, { recursive: true, force: true });
  }

  if (stderr.trim()) {
    console.error('--- host stderr ---');
    console.error(stderr.trim());
  }
}

await main();

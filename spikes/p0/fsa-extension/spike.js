// P0 spike: File System Access API behavior in extension contexts.
//
// Loaded by popup.html, page.html, and iframe.html. All three share the same
// chrome-extension:// origin, so a directory handle saved in one context can
// be loaded in another. That is the workaround under test: Chromium blocks
// showDirectoryPicker() in cross-origin iframes, so the in-page NookBin panel
// may need a top-level extension page to pick the folder once.

const DB_NAME = 'nooksuite-fsa-spike';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'library';

let currentHandle = null;

const ui = {
  context: document.getElementById('context'),
  support: document.getElementById('support'),
  status: document.getElementById('status'),
  log: document.getElementById('log'),
};

function isFramed() {
  return window.top !== window;
}

function contextName() {
  return isFramed()
    ? 'cross-origin iframe (in-page panel simulation)'
    : 'top-level extension page';
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function log(message, detail) {
  const line = document.createElement('div');
  line.className = 'log-line';

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = stamp();

  const text = document.createElement('span');
  text.textContent = message;

  line.append(time, text);

  if (detail !== undefined) {
    const pre = document.createElement('pre');
    pre.className = 'log-detail';
    pre.textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
    line.append(pre);
  }

  ui.log.append(line);
  ui.log.scrollTop = ui.log.scrollHeight;
  console.log('[fsa-spike]', message, detail ?? '');
}

function setStatus(text, tone = '') {
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
}

function describeError(error) {
  return `${error?.name || 'Error'}: ${error?.message || String(error)}`;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
  });
}

function runRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function runTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function saveHandle(handle) {
  const db = await openDb();
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(handle, HANDLE_KEY);
    await runTransaction(transaction);
  } finally {
    db.close();
  }
}

async function loadHandleFromDb() {
  const db = await openDb();
  try {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    return await runRequest(transaction.objectStore(STORE_NAME).get(HANDLE_KEY));
  } finally {
    db.close();
  }
}

async function deleteHandleFromDb() {
  const db = await openDb();
  try {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(HANDLE_KEY);
    await runTransaction(transaction);
  } finally {
    db.close();
  }
}

async function permissionState(handle) {
  if (!handle?.queryPermission) return 'unsupported';
  return handle.queryPermission({ mode: 'readwrite' });
}

async function pickFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    setStatus('showDirectoryPicker is not available in this browser.', 'bad');
    log('showDirectoryPicker is not available.');
    return;
  }

  try {
    setStatus('Opening the directory picker...');
    const handle = await window.showDirectoryPicker({
      id: 'nooksuite-library',
      mode: 'readwrite',
    });
    currentHandle = handle;
    await saveHandle(handle);
    const permission = await permissionState(handle);
    setStatus(`Picked "${handle.name}" and saved the handle (permission: ${permission}).`, 'ok');
    log('Picker succeeded.', { name: handle.name, kind: handle.kind, permission });
  } catch (error) {
    setStatus(`Picker failed: ${describeError(error)}`, 'bad');
    log('Picker failed.', describeError(error));
  }
}

async function loadHandle() {
  try {
    const handle = await loadHandleFromDb();
    if (!handle) {
      setStatus('No handle saved in IndexedDB.', 'warn');
      log('No handle found in IndexedDB.');
      return;
    }

    currentHandle = handle;
    const permission = await permissionState(handle);
    setStatus(
      `Loaded "${handle.name}" from IndexedDB (permission: ${permission}).`,
      permission === 'granted' ? 'ok' : 'warn',
    );
    log('Loaded handle from IndexedDB.', { name: handle.name, kind: handle.kind, permission });
  } catch (error) {
    setStatus(`Load failed: ${describeError(error)}`, 'bad');
    log('Load failed.', describeError(error));
  }
}

async function requestPermission() {
  const handle = currentHandle ?? (await loadHandleFromDb());
  if (!handle) {
    setStatus('No handle to request permission for.', 'warn');
    return;
  }

  currentHandle = handle;
  try {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    setStatus(
      `requestPermission returned "${permission}".`,
      permission === 'granted' ? 'ok' : 'warn',
    );
    log('requestPermission finished.', { name: handle.name, permission });
  } catch (error) {
    setStatus(`Permission request failed: ${describeError(error)}`, 'bad');
    log('requestPermission failed.', describeError(error));
  }
}

async function writeTest() {
  const handle = currentHandle ?? (await loadHandleFromDb());
  if (!handle) {
    setStatus('Pick or load a folder first.', 'warn');
    return;
  }

  currentHandle = handle;
  const report = { folder: handle.name, steps: [] };
  const step = (name, detail) => {
    report.steps.push({ name, detail });
    log(name, detail);
  };

  try {
    const permission = await permissionState(handle);
    step('queryPermission', permission);
    if (permission !== 'granted') {
      setStatus(`Write test needs permission; current state is "${permission}".`, 'bad');
      return;
    }

    const nook = await handle.getDirectoryHandle('.nooksuite', { create: true });
    step('created .nooksuite', { name: nook.name, kind: nook.kind });

    const documents = await handle.getDirectoryHandle('documents', { create: true });
    const id = `spike-${Date.now()}`;
    const idDir = await documents.getDirectoryHandle(id, { create: true });
    step('created nested documents/<id>', { id });

    const docHandle = await idDir.getFileHandle('hello.txt', { create: true });
    const docWriter = await docHandle.createWritable();
    await docWriter.write('hello from the FSA spike\n');
    await docWriter.close();
    const readBack = await (await docHandle.getFile()).text();
    step('wrote and read hello.txt', { readBack });

    const payload = JSON.stringify({ schemaVersion: 1, records: {}, spike: true }, null, 2);
    const temp = await nook.getFileHandle('library.json.tmp', { create: true });
    const tempWriter = await temp.createWritable();
    await tempWriter.write(payload);
    await tempWriter.close();

    let atomic;
    if (typeof temp.move === 'function') {
      await temp.move(nook, 'library.json');
      atomic = 'move() replaced library.json';
    } else {
      const finalHandle = await nook.getFileHandle('library.json', { create: true });
      const finalWriter = await finalHandle.createWritable();
      await finalWriter.write(payload);
      await finalWriter.close();
      atomic = 'move() unavailable; wrote library.json directly';
    }
    step('library.json write', atomic);

    const entries = [];
    for await (const [name, entry] of idDir.entries()) {
      entries.push(`${name} (${entry.kind})`);
    }
    step('listed documents/<id>', entries);

    setStatus('Write test passed.', 'ok');
    log('Write test report', report);
  } catch (error) {
    setStatus(`Write test failed: ${describeError(error)}`, 'bad');
    log('Write test failed.', { error: describeError(error), report });
  }
}

async function forgetHandle() {
  currentHandle = null;
  await deleteHandleFromDb();
  setStatus('Forgot the saved handle.', 'warn');
  log('Deleted the handle from IndexedDB.');
}

function addButton(label, handler, tone = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (tone) button.dataset.tone = tone;

  button.addEventListener('click', () => {
    Promise.resolve(handler()).catch((error) => {
      setStatus(describeError(error), 'bad');
      log('Unhandled error.', describeError(error));
    });
  });

  return button;
}

function render() {
  ui.context.textContent = contextName();
  ui.support.textContent = [
    `secureContext=${window.isSecureContext}`,
    `showDirectoryPicker=${typeof window.showDirectoryPicker}`,
    `indexedDB=${typeof indexedDB}`,
  ].join(' · ');

  const actions = document.getElementById('actions');
  actions.append(
    addButton('1. Pick folder (readwrite)', pickFolder),
    addButton('2. Load saved handle', loadHandle),
    addButton('3. Request permission', requestPermission),
    addButton('4. Run write test', writeTest),
    addButton('5. Forget handle', forgetHandle, 'danger'),
  );

  if (isFramed()) {
    log(
      'Running inside a cross-origin iframe. Expect the picker to fail with SecurityError; use step 2 to reuse a handle picked in the top-level page.',
    );
  } else {
    log(
      'Running at top level. Pick a folder here, then inject the iframe test and try step 2 there.',
    );
  }

  loadHandle();
}

render();

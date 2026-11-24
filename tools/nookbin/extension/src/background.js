// Service worker: turns toolbar clicks and the keyboard shortcut into a
// message that toggles the floating NookBin panel inside the active page.
//
// It also owns the single native messaging port to the NookSuite host, so
// every panel in every tab shares one host process and one library writer.

import { createNativeClient } from '@nooksuite/core';

const PANEL_PAGE = 'popup/popup.html';
const FALLBACK_WINDOW_KEY = 'nookbinFallbackWindowId';
const CONTENT_SCRIPTS = ['content.js'];
const NATIVE_HOST = 'dev.nooksuite.host';
const NATIVE_MESSAGE = 'nookbin:native';

let nativeClient = null;

/**
 * Connect lazily, and reconnect after a disconnect (for example once the host
 * is installed while the browser is running).
 */
function getNativeClient() {
  if (nativeClient && !nativeClient.closed) return nativeClient;

  const port = chrome.runtime.connectNative(NATIVE_HOST);
  const client = createNativeClient(port, {
    // Only available synchronously inside the disconnect listener.
    describeDisconnect: () => chrome.runtime.lastError?.message,
  });

  port.onDisconnect.addListener(() => {
    if (nativeClient === client) nativeClient = null;
  });

  nativeClient = client;
  return client;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== NATIVE_MESSAGE) return undefined;

  let client;
  try {
    client = getNativeClient();
  } catch (error) {
    sendResponse({ ok: false, error: error?.message ?? String(error) });
    return false;
  }

  client.request(message.payload ?? {}).then(
    (payload) => sendResponse({ ok: true, payload }),
    (error) =>
      sendResponse({
        ok: false,
        error: error?.message ?? String(error),
        code: error?.code,
      }),
  );

  // Keep the channel open for the asynchronous response.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setTitle({ title: 'Toggle NookBin panel' });
});

chrome.action.onClicked.addListener((tab) => {
  void togglePanel(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-panel') return;
  void togglePanelInActiveTab();
});

chrome.windows.onRemoved.addListener((windowId) => {
  void forgetFallbackWindow(windowId);
});

async function togglePanelInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await togglePanel(tab);
}

async function togglePanel(tab) {
  if (!tab || typeof tab.id !== 'number') return;

  if (await sendPanelMessage(tab.id)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      files: CONTENT_SCRIPTS,
    });
  } catch {
    // Chrome pages, the Web Store, the PDF viewer, and similar pages do not
    // allow content scripts. Fall back to a movable browser popup window.
    await openFallbackWindow();
    return;
  }

  if (await sendPanelMessage(tab.id)) return;
  await openFallbackWindow();
}

async function sendPanelMessage(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { action: 'togglePanel' },
      { frameId: 0 },
    );
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function openFallbackWindow() {
  const existingId = await getFallbackWindowId();
  if (existingId != null) {
    try {
      await chrome.windows.update(existingId, { focused: true });
      return;
    } catch {
      await chrome.storage.session.remove(FALLBACK_WINDOW_KEY);
    }
  }

  const window = await chrome.windows.create({
    url: chrome.runtime.getURL(`${PANEL_PAGE}?standalone=1`),
    type: 'popup',
    width: 580,
    height: 680,
  });

  if (window?.id != null) {
    await chrome.storage.session.set({ [FALLBACK_WINDOW_KEY]: window.id });
  }
}

async function getFallbackWindowId() {
  try {
    const stored = await chrome.storage.session.get(FALLBACK_WINDOW_KEY);
    return stored?.[FALLBACK_WINDOW_KEY] ?? null;
  } catch {
    return null;
  }
}

async function forgetFallbackWindow(windowId) {
  const existingId = await getFallbackWindowId();
  if (existingId === windowId) {
    await chrome.storage.session.remove(FALLBACK_WINDOW_KEY);
  }
}

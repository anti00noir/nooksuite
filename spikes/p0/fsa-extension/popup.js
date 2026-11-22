// Popup-only actions: open the stable top-level test page, or inject the
// iframe test into the active tab to simulate NookBin's in-page panel.

const openPageButton = document.getElementById('open-page');
const injectFrameButton = document.getElementById('inject-frame');
const status = document.getElementById('status');

openPageButton.addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('page.html') });
});

injectFrameButton.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab to inject into.');

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (frameUrl) => {
        const id = 'nooksuite-fsa-spike-frame';
        document.getElementById(id)?.remove();

        const frame = document.createElement('iframe');
        frame.id = id;
        frame.src = frameUrl;
        frame.title = 'NookSuite FSA spike';
        frame.style.cssText = [
          'position:fixed',
          'top:16px',
          'right:16px',
          'width:440px',
          'height:600px',
          'z-index:2147483647',
          'border:1px solid #3a3a3a',
          'border-radius:10px',
          'background:#161616',
          'box-shadow:0 12px 40px rgba(0,0,0,.55)',
        ].join(';');

        document.documentElement.appendChild(frame);
      },
      args: [chrome.runtime.getURL('iframe.html')],
    });

    window.close();
  } catch (error) {
    status.textContent = `Injection failed: ${error.name}: ${error.message}`;
    status.dataset.tone = 'bad';
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'capture') {
    handleCapture(msg.fileKey, msg.selector || 'body').then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ error: e.message })
    );
    return true;
  }
});

// CJK 字体预处理：动态检测系统实际渲染的 CJK 字体，替换到 DOM 上
function preprocessCJKFonts(selector) {
  const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;

  // 用 canvas 探测系统可用的 CJK 字体
  const CANDIDATES = [
    'PingFang SC', 'PingFang TC',
    'Hiragino Sans GB', 'Hiragino Sans',
    'Microsoft YaHei', 'SimHei', 'SimSun',
    'Noto Sans SC', 'Noto Sans TC',
    'Source Han Sans SC', 'Source Han Sans CN',
    'WenQuanYi Micro Hei',
    'Apple SD Gothic Neo',         // Korean macOS
    'Malgun Gothic',               // Korean Windows
    'Meiryo', 'Yu Gothic',         // Japanese Windows
  ];
  const KNOWN_RE = new RegExp(CANDIDATES.map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i');

  function detectCJKFont() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const testChar = '永';
    const size = '72px';

    // baseline: monospace 渲染宽度
    ctx.font = `${size} monospace`;
    const baseW = ctx.measureText(testChar).width;

    for (const font of CANDIDATES) {
      ctx.font = `${size} "${font}", monospace`;
      if (ctx.measureText(testChar).width !== baseW) return font;
    }
    return null;
  }

  const systemCJK = detectCJKFont();
  if (!systemCJK) return; // 没检测到任何 CJK 字体

  console.log('[figma-capture] detected CJK font:', systemCJK);

  const root = document.querySelector(selector) || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const processed = new Set();

  while (walker.nextNode()) {
    const textNode = walker.currentNode;
    if (!CJK_RE.test(textNode.textContent)) continue;

    const el = textNode.parentElement;
    if (!el || processed.has(el)) continue;
    processed.add(el);

    const families = getComputedStyle(el).fontFamily;

    // 已经包含明确的 CJK 字体名，跳过
    if (KNOWN_RE.test(families)) continue;

    // 在原有字体栈前插入检测到的系统 CJK 字体
    el.style.fontFamily = `"${systemCJK}", ${families}`;
  }
}

async function handleCapture(fileKey, selector) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('No active tab');

  // 1. 获取 captureId
  let captureId;
  try {
    const res = await fetch('https://mcp.figma.com/mcp/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileKey })
    });
    const data = await res.json();
    captureId = data.captureId || data.id;
  } catch (e) {
    console.error('Failed to get captureId:', e);
  }

  if (!captureId) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => prompt('Auto captureId failed. Paste one manually:'),
      world: 'MAIN'
    });
    captureId = results?.[0]?.result;
    if (!captureId) throw new Error('No captureId');
  }

  const endpoint = `https://mcp.figma.com/mcp/capture/${captureId}/submit`;
  console.log('captureId:', captureId, 'selector:', selector);

  // 2. 预处理 CJK 字体
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [selector],
    func: preprocessCJKFonts,
    world: 'MAIN'
  });

  // 3. 注入 capture.js
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['capture.js'],
    world: 'MAIN'
  });

  // 4. 触发捕获
  setTimeout(() => {
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [captureId, endpoint, selector],
      func: (id, ep, sel) => {
        window.figma.captureForDesign({
          captureId: id,
          endpoint: ep,
          selector: sel
        });
      },
      world: 'MAIN'
    });
  }, 1500);
}

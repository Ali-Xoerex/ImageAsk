// Content script: image enumeration + click-to-pick overlay.
// Selections are stored in chrome.storage.local so they survive popup close
// (the popup always closes as soon as the user clicks into the page).

(function () {
  if (window.__imgLlmPickerInstalled) return;
  window.__imgLlmPickerInstalled = true;

  let pickerActive = false;
  let highlightBox = null;
  let banner = null;
  let lastTarget = null;

  function absUrl(u) {
    try {
      return new URL(u, document.baseURI).href;
    } catch {
      return u;
    }
  }

  function bgImageOf(el) {
    const bg = getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    if (m && m[1] && !m[1].startsWith("data:image/svg")) return absUrl(m[1]);
    return null;
  }

  function imageForElement(el) {
    if (!el || el === document.documentElement) return null;
    // Direct <img>
    const img = el.closest ? el.closest("img, picture") : null;
    if (img) {
      const tag = img.tagName.toLowerCase() === "picture"
        ? img.querySelector("img")
        : img;
      if (tag && tag.currentSrc) return { src: absUrl(tag.currentSrc), alt: tag.alt || "" };
      if (tag && tag.src) return { src: absUrl(tag.src), alt: tag.alt || "" };
    }
    // SVG <image>
    const svgImg = el.closest ? el.closest("image") : null;
    if (svgImg) {
      const href = svgImg.getAttribute("href") || svgImg.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      if (href) return { src: absUrl(href), alt: "" };
    }
    // CSS background on element or ancestor (up to 3 levels)
    let node = el;
    for (let i = 0; i < 3 && node && node !== document.body.parentElement; i++) {
      if (node.getAttribute && node.tagName !== "IMG") {
        const bg = node.nodeType === 1 ? bgImageOf(node) : null;
        if (bg) return { src: bg, alt: "" };
      }
      node = node.parentElement;
    }
    return null;
  }

  function collectImages(onlyVisible) {
    const out = [];
    const seen = new Set();
    document.querySelectorAll("img").forEach((img) => {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith("data:image/svg")) return;
      const r = img.getBoundingClientRect();
      if (onlyVisible) {
        if (r.width < 32 || r.height < 32) return;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
      }
      const url = absUrl(src);
      if (seen.has(url)) return;
      seen.add(url);
      out.push({
        src: url,
        alt: (img.alt || "").slice(0, 200),
        w: Math.round(r.width) || img.naturalWidth || 0,
        h: Math.round(r.height) || img.naturalHeight || 0,
        pageUrl: location.href
      });
    });
    return out.slice(0, 100); // cap payload
  }

  async function addSelection(src, alt) {
    const url = absUrl(src);
    const { pendingImages = [] } = await chrome.storage.local.get("pendingImages");
    if (!pendingImages.some((i) => i.src === url)) {
      pendingImages.push({ src: url, alt: alt || "", pageUrl: location.href, addedAt: Date.now() });
      await chrome.storage.local.set({ pendingImages: pendingImages.slice(-20) });
    }
    return pendingImages.length + 1;
  }

  function ensureUi() {
    if (!highlightBox) {
      highlightBox = document.createElement("div");
      highlightBox.id = "__imgLlmHighlight";
      document.documentElement.appendChild(highlightBox);
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "__imgLlmBanner";
      banner.innerHTML =
        `<span>🖼️ Click an image to add it to your LLM query &nbsp;·&nbsp; <b>ESC</b> to stop</span>` +
        `<span id="__imgLlmCount"></span>`;
      document.documentElement.appendChild(banner);
    }
  }

  function updateCount(n) {
    const c = document.getElementById("__imgLlmCount");
    if (c) c.textContent = n ? `${n} selected — reopen the extension to ask` : "";
  }

  async function refreshCount() {
    const { pendingImages = [] } = await chrome.storage.local.get("pendingImages");
    updateCount(pendingImages.length);
  }

  function onMove(e) {
    const found = imageForElement(e.target);
    lastTarget = found ? e.target : null;
    if (found) {
      const r = e.target.closest("img")?.getBoundingClientRect() || e.target.getBoundingClientRect();
      highlightBox.style.display = "block";
      highlightBox.style.top = r.top + scrollY + "px";
      highlightBox.style.left = r.left + scrollX + "px";
      highlightBox.style.width = r.width + "px";
      highlightBox.style.height = r.height + "px";
      e.target.style.cursor = "crosshair";
    } else {
      highlightBox.style.display = "none";
    }
  }

  async function onClick(e) {
    const found = imageForElement(e.target);
    if (!found) return; // let normal clicks pass through
    e.preventDefault();
    e.stopPropagation();
    await addSelection(found.src, found.alt);
    await refreshCount();
    // brief flash
    highlightBox.style.background = "rgba(46,160,67,.45)";
    setTimeout(() => (highlightBox.style.background = "rgba(31,111,235,.25)"), 250);
  }

  function onKey(e) {
    if (e.key === "Escape") stopPicker();
  }

  function startPicker() {
    if (pickerActive) return;
    pickerActive = true;
    ensureUi();
    banner.style.display = "flex";
    refreshCount();
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
  }

  function stopPicker() {
    pickerActive = false;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    if (highlightBox) highlightBox.style.display = "none";
    if (banner) banner.style.display = "none";
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg.type === "PING") sendResponse({ ok: true });
      else if (msg.type === "GET_IMAGES") sendResponse({ images: collectImages(msg.onlyVisible) });
      else if (msg.type === "START_PICKER") { startPicker(); sendResponse({ ok: true }); }
      else if (msg.type === "STOP_PICKER") { stopPicker(); sendResponse({ ok: true }); }
      else if (msg.type === "PICKER_ACTIVE") sendResponse({ active: pickerActive });
    })();
    return true; // async response
  });
})();

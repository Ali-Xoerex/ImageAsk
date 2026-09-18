// Popup logic: manage image list, settings, and OpenRouter call.
const $ = (id) => document.getElementById(id);
const els = {
  apiKey: $("apiKey"), saveKey: $("saveKey"), keyMsg: $("keyMsg"),
  pickBtn: $("pickBtn"), visibleBtn: $("visibleBtn"), allBtn: $("allBtn"), clearBtn: $("clearBtn"),
  thumbs: $("thumbs"), pageInfo: $("pageInfo"),
  modelSearch: $("modelSearch"), modelRefresh: $("modelRefresh"), visionOnly: $("visionOnly"),
  modelList: $("modelList"), modelCount: $("modelCount"), modelSelected: $("modelSelected"),
  preset: $("preset"), prompt: $("prompt"), resize: $("resize"),
  askBtn: $("askBtn"), copyBtn: $("copyBtn"), sourceBtn: $("sourceBtn"),
  askSpin: $("askSpin"), askLabel: $("askLabel"),
  status: $("status"), result: $("result"),
};

let pendingImages = []; // [{src, alt, pageUrl}]
let allModels = []; // [{id, name, context, pricing, vision}]
let currentModel = "openai/gpt-4o-mini";
let activeIdx = -1;

init();

async function init() {
  const stored = await chrome.storage.local.get(["pendingImages", "apiKey", "model", "prompt", "visionOnly"]);
  pendingImages = stored.pendingImages || [];
  if (stored.apiKey) els.apiKey.value = stored.apiKey;
  if (stored.model) currentModel = stored.model;
  // One-time cleanup: the old search-click bug could persist a raw search
  // query (e.g. "gpt") as the model id. Reset obvious non-ids to default.
  if (currentModel && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(currentModel)) {
    currentModel = "openai/gpt-4o-mini";
    chrome.storage.local.set({ model: currentModel });
  }
  if (stored.prompt) els.prompt.value = stored.prompt;
  if (typeof stored.visionOnly === "boolean") els.visionOnly.checked = stored.visionOnly;
  renderThumbs();
  updateModelSelected();
  await showPageInfo();
  setupModelSearch();
  loadModels(false); // async, cached first

  els.saveKey.onclick = async () => {
    const key = els.apiKey.value.trim();
    if (!key) return showKeyMsg("Enter your API key first.", true);
    try {
      await chrome.storage.local.set({ apiKey: key });
      if (!key.startsWith("sk-or-")) {
        showKeyMsg("Saved — note: OpenRouter keys usually start with “sk-or-v1-”.", false);
      } else {
        showKeyMsg("API key saved ✓", false);
      }
      flashSaved(els.saveKey);
    } catch (e) {
      showKeyMsg("Save failed: " + (e.message || e), true);
    }
  };
  els.visionOnly.onchange = () => {
    chrome.storage.local.set({ visionOnly: els.visionOnly.checked });
    renderModelList(false);
  };
  els.preset.onchange = () => {
    if (els.preset.value) {
      els.prompt.value = els.prompt.value ? els.prompt.value + "\n" + els.preset.value : els.preset.value;
      els.preset.value = "";
    }
  };
  els.prompt.oninput = () => chrome.storage.local.set({ prompt: els.prompt.value });

  els.pickBtn.onclick = startPicker;
  els.visibleBtn.onclick = () => addFromPage(true);
  els.allBtn.onclick = () => addFromPage(false);
  els.clearBtn.onclick = async () => {
    pendingImages = [];
    await chrome.storage.local.set({ pendingImages });
    renderThumbs();
  };
  els.askBtn.onclick = askLlm;
  els.sourceBtn.onclick = toggleSource;
  els.copyBtn.onclick = async () => {
    await navigator.clipboard.writeText(lastRawResult || els.result.textContent || "");
    setStatus("Result copied to clipboard (raw markdown).");
  };
}

// ---------- image collection ----------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch {
    // Not yet injected (e.g. navigation) — inject now.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
  }
}

async function startPicker() {
  const tab = await activeTab();
  if (!tab?.id || /^chrome(|-extension):/.test(tab.url || "")) {
    setStatus("Cannot pick from this browser page. Try a normal http(s) page.", true);
    return;
  }
  await ensureContent(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: "START_PICKER" });
  setStatus("Picker started — click an image in the page (popup will close). Reopen me when done.");
  window.close(); // popup must close so the user can click the page
}

async function addFromPage(onlyVisible) {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    await ensureContent(tab.id);
    const res = await chrome.tabs.sendMessage(tab.id, { type: "GET_IMAGES", onlyVisible });
    const fresh = (res?.images || []).filter((i) => !pendingImages.some((p) => p.src === i.src));
    pendingImages = [...pendingImages, ...fresh].slice(-20);
    await chrome.storage.local.set({ pendingImages });
    renderThumbs();
    setStatus(fresh.length ? `Added ${fresh.length} image(s).` : "No new images found.");
  } catch (e) {
    setStatus("Could not read images on this page (" + e.message + ")", true);
  }
}

async function showPageInfo() {
  try {
    const tab = await activeTab();
    if (tab?.url) els.pageInfo.textContent = "Page: " + new URL(tab.url).hostname;
  } catch { /* ignore */ }
}

function renderThumbs() {
  els.thumbs.innerHTML = pendingImages.length
    ? ""
    : `<span class="empty">No images yet. Pick, add, or right-click an image → “Add image to LLM query”.</span>`;
  pendingImages.forEach((img, idx) => {
    const d = document.createElement("div");
    d.className = "thumb";
    d.innerHTML = `<img loading="lazy" title="${escapeHtml(img.src)}" /><button title="Remove">×</button>`;
    d.querySelector("img").src = img.src;
    d.querySelector("button").onclick = async () => {
      pendingImages.splice(idx, 1);
      await chrome.storage.local.set({ pendingImages });
      renderThumbs();
    };
    els.thumbs.appendChild(d);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// ---------- Markdown rendering (safe, dependency-free) ----------
// All model output is HTML-escaped first; only our own tags are inserted and
// link targets are restricted to http(s), so rendered HTML cannot execute.

let lastRawResult = "";
let showSource = false;

function setResult(markdown) {
  lastRawResult = markdown || "";
  showSource = false;
  els.sourceBtn.textContent = "Source";
  els.result.classList.remove("raw");
  els.result.innerHTML = renderMarkdown(lastRawResult);
}

function toggleSource() {
  if (!lastRawResult) return;
  showSource = !showSource;
  els.sourceBtn.textContent = showSource ? "Rendered" : "Source";
  els.result.classList.toggle("raw", showSource);
  if (showSource) els.result.textContent = lastRawResult;
  else els.result.innerHTML = renderMarkdown(lastRawResult);
}

function mdLink(text, url) {
  try {
    const u = new URL(url.replace(/&amp;/g, "&"));
    if (u.protocol !== "http:" && u.protocol !== "https:") throw 0;
  } catch {
    return `${text} (${url})`; // unsafe/relative URL → plain text, no link
  }
  return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

function inlineFmt(s) {
  // s is already HTML-escaped here
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g,
    (m, alt, url) => mdLink(`🖼️ ${alt || "image"}`, url)); // images → link, never embed
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;.*?&quot;)?\)/g,
    (m, t, url) => mdLink(t, url));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]])/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*<>]+)\*/g, "<em>$1</em>");
  s = s.replace(/(^|[\s(])_([^_<>]+)_([\s).,;!?]|$)/g, "$1<em>$2</em>$3");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s;
}

function renderList(items) {
  let html = "";
  const stack = []; // [{indent, tag}]
  const taskify = (t) => t
    .replace(/^\[ \]\s+/, '<input type="checkbox" disabled> ')
    .replace(/^\[[xX]\]\s+/, '<input type="checkbox" disabled checked> ');
  for (const ln of items) {
    const tag = ln.ordered ? "ol" : "ul";
    while (stack.length && ln.indent < stack[stack.length - 1].indent) {
      html += "</li></" + stack.pop().tag + ">";
    }
    const top = stack[stack.length - 1];
    const text = inlineFmt(taskify(ln.text));
    if (!top || ln.indent > top.indent) {
      html += `<${tag}><li>${text}`;
      stack.push({ indent: ln.indent, tag });
    } else if (top.tag !== tag) {
      html += "</li></" + stack.pop().tag + ">";
      html += `<${tag}><li>${text}`;
      stack.push({ indent: ln.indent, tag });
    } else {
      html += `</li><li>${text}`;
    }
  }
  while (stack.length) html += "</li></" + stack.pop().tag + ">";
  return html;
}

function renderTable(head, delim, rest) {
  const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const aligns = cells(delim).map((d) =>
    /^:-+:$/.test(d) ? "center" : (/^-+:$/.test(d) ? "right" : ""));
  const cell = (c, k, tag) =>
    `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ""}>${inlineFmt(c)}</${tag}>`;
  let rows = "";
  for (const l of rest) {
    if (!l.includes("|") || l.trim() === "") break;
    rows += `<tr>${cells(l).map((c, k) => cell(c, k, "td")).join("")}</tr>`;
  }
  return `<table><thead><tr>${cells(head).map((c, k) => cell(c, k, "th")).join("")}</tr></thead><tbody>${rows}</tbody></table>`;
}

function renderMarkdown(src) {
  const codeBlocks = [];
  const codeSpans = [];
  const PH = (k, i) => `${k}${i}`;

  // 1. Fenced code blocks (extract before escaping)
  let s = String(src).replace(/```([^\n`]*)\s*\n([\s\S]*?)(?:```|$)/g, (m, lang, code) => {
    codeBlocks.push(`<pre><code${lang.trim() ? ` class="lang-${escapeHtml(lang.trim())}"` : ""}>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return PH("B", codeBlocks.length - 1);
  });

  // 2. Escape everything else
  s = escapeHtml(s);

  // 3. Inline code spans (shield from inline formatting)
  s = s.replace(/`([^`\n]+)`/g, (m, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return PH("C", codeSpans.length - 1);
  });

  const lines = s.split("\n");
  const isTableDelim = (l) => l.includes("|") && l.includes("-") && /^\|?[\s:|-]+\|?$/.test(l);
  let html = "";
  let para = [];
  const flushPara = () => {
    if (para.length) { html += `<p>${inlineFmt(para.join("<br>"))}</p>`; para = []; }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) { flushPara(); html += `<h${m[1].length}>${inlineFmt(m[2])}</h${m[1].length}>`; i++; continue; }
    if (/^([BC]\d+\s*)+$/.test(line)) { flushPara(); html += line; i++; continue; }
    if (/^(\*\*\*|---|___)\s*$/.test(line)) { flushPara(); html += "<hr>"; i++; continue; }
    if (/^&gt;/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length && /^&gt;/.test(lines[i])) { q.push(lines[i].replace(/^&gt;\s?/, "")); i++; }
      html += `<blockquote>${inlineFmt(q.join("<br>"))}</blockquote>`;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isTableDelim(lines[i + 1])) {
      flushPara();
      html += renderTable(line, lines[i + 1], lines.slice(i + 2));
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") i++;
      continue;
    }
    m = line.match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
    if (m) {
      flushPara();
      const items = [];
      while (i < lines.length) {
        const lm = lines[i].match(/^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/);
        if (!lm) break;
        items.push({ indent: lm[1].replace(/\t/g, "  ").length, ordered: !!lm[3], text: lm[4] });
        i++;
      }
      html += renderList(items);
      continue;
    }
    if (line.trim() === "") { flushPara(); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara();

  // 4. Restore code (already escaped at insert time)
  html = html.replace(/B(\d+)/g, (mm, n) => codeBlocks[+n] ?? "")
             .replace(/C(\d+)/g, (mm, n) => codeSpans[+n] ?? "");
  return html || "<p>—</p>";
}

// ---------- OpenRouter models (searchable, loads all) ----------

const FALLBACK_MODELS = [
  "openai/gpt-4o", "openai/gpt-4o-mini", "google/gemini-2.0-flash-001",
  "anthropic/claude-3.5-sonnet", "qwen/qwen-2-vl-72b-instruct",
  "meta-llama/llama-3.2-11b-vision-instruct"
].map((id) => ({ id, name: id, context: 0, pricing: null, vision: true }));

function isVisionModel(m) {
  const arch = m.architecture || {};
  if (typeof arch.modality === "string" && arch.modality.includes("image")) return true;
  if (Array.isArray(arch.input_modalities) && arch.input_modalities.includes("image")) return true;
  if (Array.isArray(m.input_modalities) && m.input_modalities.includes("image")) return true;
  return /vision|vl-|image|gpt-4o|claude-3|gemini/i.test(m.id + " " + (m.name || "") + " " + (m.description || ""));
}

function setupModelSearch() {
  els.modelRefresh.onclick = () => loadModels(true, true);
  els.modelSearch.value = currentModel || "";
  els.modelSearch.addEventListener("input", () => { activeIdx = -1; renderModelList(); });
  els.modelSearch.addEventListener("focus", () => renderModelList());
  els.modelSearch.addEventListener("keydown", (e) => {
    const items = [...els.modelList.querySelectorAll(".model-item")];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activeIdx = e.key === "ArrowDown" ? Math.min(items.length - 1, activeIdx + 1) : Math.max(0, activeIdx - 1);
      items.forEach((el, i) => el.classList.toggle("active", i === activeIdx));
      items[activeIdx]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const el = items[activeIdx >= 0 ? activeIdx : 0];
      const typed = els.modelSearch.value.trim();
      if (el?.dataset?.id) { e.preventDefault(); selectModel(el.dataset.id); }
      else if (typed) { e.preventDefault(); selectModel(typed); }
    } else if (e.key === "Escape") {
      els.modelList.hidden = true;
    }
  });
  // Note: deliberately NO "change"/blur auto-select here. A blur handler that
  // hides the list would run between mousedown and mouseup on a dropdown item
  // and swallow the click, so the real model never gets selected. Manually
  // typed ids are picked up in selectedModel() when asking.
  document.addEventListener("click", (e) => {
    if (!els.modelList.hidden && !els.modelList.contains(e.target) && e.target !== els.modelSearch) {
      els.modelList.hidden = true;
    }
  });
}

async function loadModels(force, open = false) {
  // Cached first for instant popup; refresh in background (24h TTL).
  // Never auto-opens the dropdown (open=false) except on explicit refresh —
  // the overlay would cover the prompt section below the search box.
  const cached = await chrome.storage.local.get(["orModels", "orModelsAt"]);
  if (cached.orModels?.length && !force) {
    allModels = cached.orModels;
    renderModelList(false);
    if (Date.now() - (cached.orModelsAt || 0) > 24 * 3600 * 1000) loadModels(true, false);
    return;
  }
  els.modelCount.textContent = "loading…";
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    allModels = (data.data || []).map((m) => ({
      id: m.id,
      name: m.name || m.id,
      context: m.context_length || 0,
      pricing: m.pricing || null,
      vision: isVisionModel(m),
      created: m.created || 0
    })).sort((a, b) => a.id.localeCompare(b.id));
    await chrome.storage.local.set({ orModels: allModels, orModelsAt: Date.now() });
  } catch (e) {
    allModels = cached.orModels?.length ? cached.orModels : FALLBACK_MODELS;
    els.modelCount.textContent = "offline list";
  }
  renderModelList(open);
  // Flag a selected id the catalog doesn't know (retired/renamed → API errors).
  if (currentModel && !allModels.some((m) => m.id === currentModel)) {
    els.modelSelected.textContent = `⚠️ "${currentModel}" is not in OpenRouter's catalog — re-select from the list.`;
    els.modelSelected.style.color = "#cf222e";
  }
}

function filteredModels() {
  const q = els.modelSearch.value.trim().toLowerCase();
  let list = allModels;
  if (els.visionOnly.checked) list = list.filter((m) => m.vision);
  // Empty query (or query == selected model) → show all (capped)
  if (q && q !== (currentModel || "").toLowerCase()) {
    list = list.filter((m) => (m.id + " " + m.name).toLowerCase().includes(q));
  }
  return list.slice(0, 80);
}

function fmtPrice(p) {
  if (!p?.prompt) return "";
  const per1k = parseFloat(p.prompt) * 1000;
  return per1k === 0 ? "free" : `$${per1k.toFixed(per1k < 0.01 ? 4 : 2)}/1k`;
}

function renderModelList(open = true) {
  const list = filteredModels();
  els.modelCount.textContent = `${list.length}/${allModels.length} shown`;
  if (!list.length) {
    els.modelList.innerHTML = `<div class="model-item">No match — press Enter to use “${escapeHtml(els.modelSearch.value.trim())}” as a custom id.</div>`;
    els.modelList.hidden = !open;
    return;
  }
  els.modelList.innerHTML = "";
  list.forEach((m) => {
    const d = document.createElement("div");
    d.className = "model-item" + (m.id === currentModel ? " active" : "");
    d.dataset.id = m.id;
    d.innerHTML =
      `<div class="m-name">${escapeHtml(m.name)}${m.vision ? `<span class="badge-vision">vision</span>` : ""}</div>` +
      `<div class="m-id">${escapeHtml(m.id)}</div>` +
      `<div class="m-meta">${m.context ? (m.context / 1000).toFixed(0) + "k ctx · " : ""}${escapeHtml(fmtPrice(m.pricing))}</div>`;
    // mousedown (not click): blur fires between mousedown and mouseup, so a
    // click handler can be swallowed when the list hides. mousedown runs first.
    d.onmousedown = (e) => { e.preventDefault(); selectModel(m.id); };
    els.modelList.appendChild(d);
  });
  els.modelList.hidden = !open;
}

async function selectModel(id, silent) {
  currentModel = id.trim();
  els.modelSearch.value = currentModel;
  els.modelList.hidden = true;
  await chrome.storage.local.set({ model: currentModel });
  updateModelSelected();
  if (!silent) setStatus(`Model: ${currentModel}`);
}

function updateModelSelected() {
  els.modelSelected.textContent = currentModel ? `Selected: ${currentModel}` : "";
  els.modelSelected.style.color = "";
}

function selectedModel() {
  // Allow manual custom id typed in the search box even if never clicked.
  const typed = (els.modelSearch.value || "").trim();
  if (typed && typed !== currentModel) {
    currentModel = typed;
    chrome.storage.local.set({ model: currentModel });
    updateModelSelected();
  }
  return currentModel;
}

async function imageToDataUrl(src, downscale) {
  // Fetch through the extension (host_permissions allow most pages) then
  // optionally downscale via canvas to keep the request small.
  const res = await fetch(src, { credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error("not an image");
  if (!downscale) return await blobToDataUrl(blob);

  const bitmap = await createImageBitmap(blob);
  const MAX = 1024;
  const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && blob.size < 1_200_000) return await blobToDataUrl(blob);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.82);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function setStatus(msg, isError) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("error", !!isError);
}

let thinkTimer = null;
function setAsking(on) {
  els.askBtn.disabled = on;
  els.askSpin.hidden = !on;
  els.askLabel.textContent = on ? " Thinking…" : "✨ Ask LLM";
  if (!on) clearInterval(thinkTimer);
}

function showThinking() {
  const t0 = Date.now();
  lastRawResult = "";
  showSource = false;
  els.sourceBtn.textContent = "Source";
  els.result.classList.remove("raw");
  els.result.innerHTML = `<div class="thinking"><span class="spinner lg"></span><span>Thinking… <span id="thinkSecs">0s</span></span></div>`;
  clearInterval(thinkTimer);
  thinkTimer = setInterval(() => {
    const el = document.getElementById("thinkSecs");
    if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + "s";
  }, 500);
}

let keyMsgTimer = null;
function showKeyMsg(msg, isError) {
  els.keyMsg.textContent = msg || "";
  els.keyMsg.classList.toggle("error", !!isError);
  clearTimeout(keyMsgTimer);
  // Auto-clear confirmations (keep errors visible until next attempt).
  if (!isError && msg) {
    keyMsgTimer = setTimeout(() => {
      if (!els.keyMsg.classList.contains("error")) els.keyMsg.textContent = "";
    }, 5000);
  }
}

function flashSaved(btn) {
  const orig = btn.textContent;
  btn.textContent = "✓ Saved";
  btn.disabled = true;
  setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
}

async function askLlm() {
  const apiKey = els.apiKey.value.trim();
  const prompt = els.prompt.value.trim();
  const model = selectedModel();

  if (!apiKey) return setStatus("Enter your OpenRouter API key first.", true);
  if (!pendingImages.length) return setStatus("Add at least one image first.", true);
  if (!prompt) return setStatus("Write a prompt first.", true);
  if (!model) return setStatus("Choose a model.", true);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(model)) {
    return setStatus(`"${model}" is not a model id (expected "provider/name"). Pick one from the dropdown list.`, true);
  }

  els.askBtn.disabled = true;
  setAsking(true);
  setStatus("Preparing images…");
  showThinking();

  try {
    // Convert images; fall back to remote URL if fetch is blocked (hotlink protection etc.)
    const parts = [{ type: "text", text: prompt }];
    let converted = 0;
    for (const img of pendingImages.slice(0, 10)) {
      try {
        parts.push({ type: "image_url", image_url: { url: await imageToDataUrl(img.src, els.resize.checked) } });
        converted++;
      } catch {
        parts.push({ type: "image_url", image_url: { url: img.src } });
      }
    }
    const body = {
      model,
      messages: [{ role: "user", content: parts }],
      max_tokens: 1500
    };
    const kb = Math.round(JSON.stringify(body).length / 1024);
    setStatus(`Asking ${model} (${converted}/${parts.length - 1} embedded, rest by URL, ~${kb} KB)…`);

    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/image-llm-extension",
        "X-Title": "ImageAsk (browser extension)"
      },
      body: JSON.stringify(body)
    });

    const reqId = res.headers.get("x-request-id") || "";
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(formatApiError(res.status, data?.error, reqId, model));
    }
    // HTTP 200 but the provider failed behind OpenRouter's gateway
    const choice = data?.choices?.[0];
    const choiceErr = choice?.error || (choice?.finish_reason === "error" && !choice?.message?.content
      ? { message: "provider finished with finish_reason=error and no content" }
      : null);
    if (data?.error || choiceErr) {
      throw new Error(formatApiError(res.status, data?.error || choiceErr, reqId, model));
    }
    const text = data?.choices?.[0]?.message?.content?.trim() || "(empty response)";
    setResult(text);
    setStatus(`Done · ${model} · ${data?.usage?.total_tokens ?? "?"} tokens.`);
  } catch (e) {
    // Diagnostics stay plain text (not markdown-rendered).
    lastRawResult = "";
    showSource = false;
    els.sourceBtn.textContent = "Source";
    els.result.classList.remove("raw");
    els.result.textContent = String(e.message || e);
    setStatus("Request failed — full details above.", true);
  } finally {
    setAsking(false);
  }
}

function formatApiError(status, err, reqId, model) {
  const msg = typeof err === "string"
    ? err
    : (err?.message || JSON.stringify(err ?? {}).slice(0, 800) || "unknown error");
  const code = err && typeof err === "object" && err.code != null ? ` · code ${err.code}` : "";
  const meta = err && typeof err === "object" && err.metadata
    ? `\nMeta: ${JSON.stringify(err.metadata).slice(0, 400)}`
    : "";
  return [
    `Model: ${model}`,
    `HTTP ${status}${code}${reqId ? ` · req ${reqId}` : ""}`,
    `Message: ${msg}${meta}`,
    "",
    "Common fixes: re-select the model from the list (ids change), try openai/gpt-4o-mini, " +
    "check credits at openrouter.ai/activity, send fewer/smaller images."
  ].join("\n");
}

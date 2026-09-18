# ImageAsk — Ask an LLM About Page Images (OpenRouter, Manifest V3)

Select images on any webpage, write a prompt, send both to an OpenRouter vision model, and read the answer — all from the toolbar popup.

Works in Chrome / Edge / Brave (and Firefox with MV3 support).

## Features
- 🎯 **Click-to-pick mode**: hover highlights images, click adds them (popup closes, selection persists; reopen popup when done)
- 👁️ **Add visible / Add all**: bulk-add images from the current tab
- 🖱️ **Right-click any image → “Add image to LLM query”** (context menu)
- ✍️ Prompt box + presets (describe, OCR, compare, alt text…)
- 🤖 Searchable model picker: loads **all** OpenRouter models via `GET /api/v1/models` (cached 24h, ↻ to refresh), filters as you type, “Vision-capable only” toggle, ↑/↓ + Enter keyboard support, custom id fallback
- 🖼️ Images are embedded as base64 (downscaled to ≤1024px JPEG) with automatic fallback to URL
- 🔑 API key stored locally via `chrome.storage.local` only
- 🔢 Toolbar badge shows how many images are queued

## Install (developer mode)
1. Go to `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder (the one containing `manifest.json`).
3. Pin the extension, then open any page with images.

## Use
1. Click the extension icon.
2. Paste your OpenRouter key from https://openrouter.ai/keys → **Save**.
3. Add images: **Pick from page**, **Add visible**, **Add all**, or right-click an image.
4. Choose a vision model (e.g. `openai/gpt-4o-mini`), write your prompt.
5. **Ask LLM** → answer appears rendered in the Result box (built-in Markdown rendering: headings, lists, tables, code; **Source** toggles raw text, Copy copies raw Markdown).

> Note: the popup always closes when you click into the page — that's a browser rule. The picker banner stays on the page; just reopen the extension afterwards. Your picks are kept in `pendingImages`.

## How the OpenRouter call works
`POST https://openrouter.ai/api/v1/chat/completions`
```json
{
  "model": "openai/gpt-4o-mini",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe these images…" },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,…" } }
    ]
  }]
}
```
Headers: `Authorization: Bearer $KEY`, `HTTP-Referer`, `X-Title`.

## Files
| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest, permissions, content script registration |
| `popup.html/.css/.js` | Toolbar UI, image queue, OpenRouter request |
| `content.js/.css` | Image enumeration + picker overlay |
| `background.js` | Context menu + badge count |

## Limits & tips
- Max 20 queued images, max 10 sent per request (vision cost grows fast).
- Some sites block hotlinking — the extension then sends the raw URL and the model fetches it; if that fails, try another image.
- `chrome://`, `edge://`, and the Chrome Web Store block content scripts — test on a normal `https://` page.
- vision support varies by model; if a model says it can't see images, switch to `openai/gpt-4o` or `google/gemini-2.0-flash-001`.

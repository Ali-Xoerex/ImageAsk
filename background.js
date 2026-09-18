// Background worker: context-menu "add image" + badge count.

const MENU_ID = "img-llm-add";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: "Add image to LLM query",
    contexts: ["image"]
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;
  const { pendingImages = [] } = await chrome.storage.local.get("pendingImages");
  if (!pendingImages.some((i) => i.src === info.srcUrl)) {
    pendingImages.push({ src: info.srcUrl, alt: "", pageUrl: info.pageUrl, addedAt: Date.now() });
    await chrome.storage.local.set({ pendingImages: pendingImages.slice(-20) });
  }
  await updateBadge();
});

chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.pendingImages) updateBadge();
});

async function updateBadge() {
  try {
    const { pendingImages = [] } = await chrome.storage.local.get("pendingImages");
    const n = pendingImages.length;
    await chrome.action.setBadgeText({ text: n ? String(n) : "" });
    if (n) await chrome.action.setBadgeBackgroundColor({ color: "#1f6feb" });
  } catch {
    /* service worker may lack action in some contexts */
  }
}

updateBadge();

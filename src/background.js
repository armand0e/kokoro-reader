// Service worker: routes messages between popup / content scripts / offscreen engine, owns context menus,
// keyboard shortcuts and tab lifecycle.
import { getSettings, onSettingsChanged } from "./shared/settings.js";

const OFFSCREEN_URL = "offscreen/offscreen.html";
let lastState = null;
let readingTabId = null;

// ---------- offscreen document ----------
let creating = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS", "BLOBS"],
        justification: "Runs the Kokoro text-to-speech model in a web worker and plays the synthesized audio.",
      })
      .catch((e) => {
        if (!String(e).includes("Only a single offscreen")) throw e;
      })
      .finally(() => (creating = null));
  }
  await creating;
}

async function offscreen(msg) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
  if (!res) throw new Error("No response from engine");
  if (!res.ok) throw new Error(res.error || "Engine error");
  return res.result;
}

// ---------- content scripts ----------
async function sendToTab(tabId, msg, { inject = true } = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    if (!inject) throw err;
    // Content script not present yet (tab opened before install, or discarded) — inject and retry.
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (e) {
      throw new Error("This page can't be read (Chrome doesn't allow extensions here).");
    }
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

async function tabAction(tabId, action, extra = {}) {
  const settings = await getSettings();
  return sendToTab(tabId, { type: `cs:${action}`, settings, ...extra });
}

// ---------- state fan-out ----------
function broadcastState(state) {
  lastState = state;
  const tabId = state.session?.tabId ?? state.endedSession?.tabId ?? readingTabId;
  if (state.session) readingTabId = state.session.tabId;
  else if (state.endedSession) readingTabId = null;
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: "player:state", state }).catch(() => {});
  }
  chrome.runtime.sendMessage({ target: "popup", type: "state", state }).catch(() => {});
}

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.target && msg.target !== "background")) return false;
  route(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

async function route(msg, sender) {
  switch (msg.type) {
    // --- from offscreen ---
    case "state":
      broadcastState(msg.state);
      return;
    case "offscreenReady": {
      const settings = await getSettings();
      chrome.runtime.sendMessage({ target: "offscreen", type: "settings", settings }).catch(() => {});
      return;
    }
    case "download":
      return chrome.downloads.download({ url: msg.url, filename: msg.filename || "kokoro-reader.wav", saveAs: msg.saveAs !== false });

    // --- from content scripts ---
    case "cs:play": {
      const tabId = sender.tab?.id;
      if (tabId == null) throw new Error("No tab");
      const settings = await getSettings();
      readingTabId = tabId;
      return offscreen({ type: "play", tabId, chunks: msg.chunks, startIndex: msg.startIndex || 0, title: msg.title, settings });
    }
    case "cs:control":
      return control(msg.action, msg);
    case "cs:getState":
      return lastState;

    // --- from popup / options ---
    case "ui:getState": {
      let state = lastState;
      try {
        state = await offscreen({ type: "getState" });
      } catch {}
      return { state, readingTabId };
    }
    case "ui:readPage": {
      const tab = await activeTab();
      return tabAction(tab.id, "readPage", { mode: msg.mode });
    }
    case "ui:readSelection": {
      const tab = await activeTab();
      return tabAction(tab.id, "readSelection");
    }
    case "ui:pick": {
      const tab = await activeTab();
      return tabAction(tab.id, "pick");
    }
    case "ui:pageInfo": {
      const tab = await activeTab();
      try {
        return await tabAction(tab.id, "pageInfo");
      } catch (e) {
        return { error: String(e.message || e), url: tab.url, title: tab.title };
      }
    }
    case "ui:control":
      return control(msg.action, msg);
    case "ui:preview":
      return offscreen({ type: "preview", voice: msg.voice, text: msg.text });
    case "ui:loadModel":
      return offscreen({ type: "preload", settings: await getSettings() });
    case "ui:reloadModel":
      return offscreen({ type: "reloadModel" });
    case "ui:cacheInfo":
      return offscreen({ type: "cacheInfo" });
    case "ui:clearCache":
      return offscreen({ type: "clearCache" });
    case "ui:exportWav": {
      const tab = await activeTab();
      const res = await tabAction(tab.id, "getChunks", { mode: msg.mode, selectionOnly: msg.selectionOnly });
      if (!res || !res.chunks?.length) throw new Error("No readable text found on this page");
      const safe = (tab.title || "page").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
      offscreen({ type: "exportWav", chunks: res.chunks, filename: `${safe}.wav`, saveAs: msg.saveAs !== false }).catch((e) => console.warn(e));
      return { total: res.chunks.length };
    }
    case "ui:cancelExport":
      return offscreen({ type: "cancelExport" });
    default:
      throw new Error(`Unknown message: ${msg.type}`);
  }
}

async function control(action, msg = {}) {
  switch (action) {
    case "pause":
    case "resume":
    case "toggle":
    case "stop":
    case "next":
    case "prev":
      return offscreen({ type: action });
    case "seekTo":
      return offscreen({ type: "seekTo", index: msg.index });
    default:
      throw new Error(`Unknown control: ${action}`);
  }
}

// ---------- settings sync ----------
onSettingsChanged((settings) => {
  chrome.runtime.sendMessage({ target: "offscreen", type: "settings", settings }).catch(() => {});
  // Keep any reading tab informed about highlight / mini-player preferences.
  if (readingTabId != null) chrome.tabs.sendMessage(readingTabId, { type: "cs:settings", settings }).catch(() => {});
});

// ---------- context menus ----------
const MENUS = [
  { id: "read-page", title: "Read this page aloud", contexts: ["page"] },
  { id: "read-selection", title: "Read selection aloud", contexts: ["selection"] },
  { id: "read-from-here", title: "Start reading from here", contexts: ["page", "link", "image", "selection"] },
  { id: "pick-element", title: "Pick an element to read…", contexts: ["page", "selection", "link", "image"] },
  { id: "sep", type: "separator", contexts: ["all"] },
  { id: "toggle", title: "Play / pause reading", contexts: ["all"] },
  { id: "stop", title: "Stop reading", contexts: ["all"] },
];

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const m of MENUS) {
      chrome.contextMenus.create({ id: m.id, title: m.title, type: m.type || "normal", contexts: m.contexts, documentUrlPatterns: ["http://*/*", "https://*/*", "file:///*"] });
    }
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  try {
    switch (info.menuItemId) {
      case "read-page":
        await tabAction(tab.id, "readPage");
        break;
      case "read-selection":
        await tabAction(tab.id, "readSelection");
        break;
      case "read-from-here":
        await tabAction(tab.id, "readFromHere");
        break;
      case "pick-element":
        await tabAction(tab.id, "pick", { fromContextMenu: true });
        break;
      case "toggle":
        await control("toggle");
        break;
      case "stop":
        await control("stop");
        break;
    }
  } catch (e) {
    console.warn("context menu action failed", e);
  }
});

// ---------- keyboard shortcuts ----------
chrome.commands.onCommand.addListener(async (command, tab) => {
  try {
    const t = tab?.id ? tab : await activeTab();
    switch (command) {
      case "read-page-or-toggle": {
        const readingTab = await currentReadingTab();
        if (readingTab != null && lastState?.session && ["playing", "paused", "buffering"].includes(lastState.session.status)) await control("toggle");
        else await tabAction(t.id, "readPage");
        break;
      }
      case "read-selection":
        await tabAction(t.id, "readSelection");
        break;
      case "pick-element":
        await tabAction(t.id, "pick");
        break;
      case "stop":
        await control("stop");
        break;
    }
  } catch (e) {
    console.warn("command failed", e);
  }
});

// ---------- tab lifecycle ----------
/** Which tab is being read right now (module state may be gone after a service-worker restart). */
async function currentReadingTab() {
  if (readingTabId != null) return readingTabId;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (!contexts.length) return null;
  try {
    const st = await offscreen({ type: "getState" });
    lastState = st;
    readingTabId = st?.session?.tabId ?? null;
    return readingTabId;
  } catch {
    return null;
  }
}
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await currentReadingTab())) control("stop").catch(() => {});
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status === "loading" && tabId === (await currentReadingTab())) control("stop").catch(() => {});
});

// ---------- install / startup ----------
async function preloadIfWanted() {
  const settings = await getSettings();
  if (settings.preload) offscreen({ type: "preload", settings }).catch((e) => console.warn("preload failed", e));
}

chrome.runtime.onInstalled.addListener(async (details) => {
  createMenus();
  // Make the extension work in tabs that were already open.
  if (details.reason === "install" || details.reason === "update") {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
    }
  }
  preloadIfWanted();
});
chrome.runtime.onStartup.addListener(() => {
  createMenus();
  preloadIfWanted();
});

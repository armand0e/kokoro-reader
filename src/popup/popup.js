import { VOICES } from "../shared/voices.js";
import { getSettings, saveSettings } from "../shared/settings.js";

const $ = (s) => document.querySelector(s);
let settings = null;
let state = null;

function bg(msg) {
  return chrome.runtime.sendMessage({ target: "background", ...msg }).then((r) => {
    if (!r) throw new Error("No response");
    if (!r.ok) throw new Error(r.error || "Failed");
    return r.result;
  });
}

function showError(msg) {
  const el = $("#error");
  el.textContent = msg || "";
  el.hidden = !msg;
}

function fmtMB(b) {
  return `${(b / 1048576).toFixed(0)} MB`;
}

// ---------- voice UI ----------
function buildVoiceSelect() {
  const sel = $("#voice");
  sel.innerHTML = "";
  for (const gender of ["Female", "Male"]) {
    const og = document.createElement("optgroup");
    og.label = gender;
    for (const [id, v] of Object.entries(VOICES)) {
      if (v.gender !== gender) continue;
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = `${v.name} — ${v.accent} · grade ${v.grade}`;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
  sel.value = settings.voice;
  $("#voice-tagline").textContent = VOICES[settings.voice]?.tagline || "";
  sel.addEventListener("change", async () => {
    settings = await saveSettings({ voice: sel.value });
    $("#voice-tagline").textContent = VOICES[sel.value]?.tagline || "";
  });
}

function bindSpeed() {
  const input = $("#speed");
  const val = $("#speed-val");
  input.value = settings.speed;
  val.textContent = `${Number(settings.speed).toFixed(2).replace(/0$/, "")}×`;
  input.addEventListener("input", () => (val.textContent = `${Number(input.value).toFixed(2).replace(/0$/, "")}×`));
  input.addEventListener("change", async () => {
    settings = await saveSettings({ speed: Number(input.value) });
  });
}

// ---------- render ----------
function render() {
  if (!state) return;
  const m = state.model || {};
  const chip = $("#engine-chip");
  chip.className = "chip";
  if (m.status === "ready") {
    chip.textContent = `${(m.device || "").toUpperCase()} · ${m.dtype} · ready`;
  } else if (m.status === "loading") {
    chip.textContent = `Loading ${m.progress?.pct ?? 0}%`;
    chip.classList.add("warn");
  } else if (m.status === "error") {
    chip.textContent = "Engine error";
    chip.classList.add("err");
  } else {
    chip.textContent = "Model not loaded";
    chip.classList.add("warn");
  }

  const mp = $("#model-panel");
  const showModel = m.status !== "ready";
  mp.hidden = !showModel;
  if (showModel) {
    if (m.status === "loading") {
      $("#model-text").textContent = `Downloading / loading model… ${m.progress?.pct ?? 0}%${m.progress?.total ? ` (${fmtMB(m.progress.loaded)} of ${fmtMB(m.progress.total)})` : ""}`;
      $("#btn-load").hidden = true;
    } else if (m.status === "error") {
      $("#model-text").textContent = `Could not load the model: ${m.error}`;
      $("#btn-load").hidden = false;
      $("#btn-load").textContent = "Retry";
    } else {
      $("#model-text").textContent = "The voice model is downloaded once (≈90–330 MB) and cached on this device.";
      $("#btn-load").hidden = false;
      $("#btn-load").textContent = "Load model";
    }
    $("#model-bar").style.width = `${m.status === "loading" ? m.progress?.pct ?? 0 : 0}%`;
  }
  const note = $("#model-note");
  note.hidden = !m.note;
  note.textContent = m.note || "";

  const s = state.session;
  const np = $("#now-playing");
  np.hidden = !s;
  if (s) {
    $("#np-title").textContent = s.title || "";
    $("#np-text").textContent = s.text || "";
    $("#np-fill").style.width = `${(s.index / Math.max(1, s.total)) * 100}%`;
    const label = s.status === "buffering" ? "Synthesizing…" : s.status === "paused" ? "Paused" : "Reading";
    $("#np-status").textContent = `${label} · ${s.index + 1} / ${s.total}`;
    $("#np-toggle").innerHTML =
      s.status === "paused"
        ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
  }

  const ex = state.export;
  $("#export-status").textContent = ex ? `Rendering ${ex.index} / ${ex.total}…` : "";
  $("#btn-cancel-export").hidden = !ex;
  $("#btn-export").disabled = !!ex;

  if (state.settings?.voice && state.settings.voice !== $("#voice").value) $("#voice").value = state.settings.voice;
}

// ---------- actions ----------
async function act(fn) {
  showError("");
  try {
    await fn();
  } catch (e) {
    showError(e.message || String(e));
  }
}

function bindActions() {
  $("#btn-read").addEventListener("click", () =>
    act(async () => {
      await bg({ type: "ui:readPage", mode: settings.extraction });
      window.close();
    }),
  );
  $("#btn-pick").addEventListener("click", () =>
    act(async () => {
      await bg({ type: "ui:pick" });
      window.close();
    }),
  );
  $("#btn-selection").addEventListener("click", () =>
    act(async () => {
      const r = await bg({ type: "ui:readSelection" });
      if (r && r.ok === false) throw new Error(r.error);
      window.close();
    }),
  );
  $("#btn-preview").addEventListener("click", () =>
    act(async () => {
      $("#btn-preview").disabled = true;
      try {
        await bg({ type: "ui:preview", voice: $("#voice").value });
      } finally {
        $("#btn-preview").disabled = false;
      }
    }),
  );
  $("#btn-load").addEventListener("click", () => act(() => bg({ type: "ui:loadModel" })));
  $("#btn-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("#btn-export").addEventListener("click", () =>
    act(async () => {
      const r = await bg({ type: "ui:exportWav", mode: settings.extraction });
      $("#export-status").textContent = `Rendering 0 / ${r.total}…`;
    }),
  );
  $("#btn-cancel-export").addEventListener("click", () => act(() => bg({ type: "ui:cancelExport" })));
  document.querySelectorAll("#now-playing button[data-act]").forEach((b) => b.addEventListener("click", () => act(() => bg({ type: "ui:control", action: b.dataset.act }))));
  $("#np-bar").addEventListener("click", (e) => {
    if (!state?.session) return;
    const r = e.currentTarget.getBoundingClientRect();
    const idx = Math.floor(((e.clientX - r.left) / r.width) * state.session.total);
    act(() => bg({ type: "ui:control", action: "seekTo", index: idx }));
  });
}

// ---------- init ----------
async function init() {
  settings = await getSettings();
  buildVoiceSelect();
  bindSpeed();
  bindActions();
  $("#read-mode-hint").textContent = settings.extraction === "smart" ? "main content · highlights as it reads" : "everything on the page";

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === "popup" && msg.type === "state") {
      state = msg.state;
      render();
    }
  });
  chrome.storage.onChanged.addListener(async () => {
    settings = await getSettings();
    $("#read-mode-hint").textContent = settings.extraction === "smart" ? "main content · highlights as it reads" : "everything on the page";
  });

  try {
    const r = await bg({ type: "ui:getState" });
    state = r.state || { model: { status: "unloaded" }, session: null };
    render();
  } catch (e) {
    state = { model: { status: "error", error: e.message }, session: null };
    render();
  }
  try {
    const info = await bg({ type: "ui:pageInfo" });
    if (info?.error) {
      $("#sel-hint").textContent = "unavailable here";
      $("#btn-read").disabled = true;
      $("#btn-pick").disabled = true;
      $("#btn-selection").disabled = true;
      showError("Chrome doesn't let extensions run on this page (e.g. chrome:// pages or the Web Store).");
    } else {
      $("#sel-hint").textContent = info.hasSelection ? "text is selected ✓" : "select text first";
    }
  } catch {}
}

init();

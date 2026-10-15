"use strict";

const toggle = document.getElementById("bounded-render");
const section = document.getElementById("render-window-section");
const slider = document.getElementById("render-window-turns");
const output = document.getElementById("render-window-value");

function clampTurns(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : 3;
}
function updateWindow(value) {
  const turns = clampTurns(value);
  slider.value = String(turns);
  output.value = `${turns} 轮`;
  output.textContent = output.value;
}
function updateVisibility(enabled) {
  section.classList.toggle("hidden", !enabled);
}

chrome.storage.local.get(SETTINGS_DEFAULTS, (items) => {
  toggle.checked = items.boundedRenderEnabled === true;
  updateWindow(items.renderWindowTurns);
  updateVisibility(toggle.checked);
});

toggle.addEventListener("change", () => {
  chrome.storage.local.set({ boundedRenderEnabled: toggle.checked });
  updateVisibility(toggle.checked);
});
slider.addEventListener("input", () => {
  const turns = clampTurns(slider.value);
  updateWindow(turns);
  chrome.storage.local.set({ renderWindowTurns: turns });
});

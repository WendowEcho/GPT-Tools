"use strict";

// Settings for Bounded Render only.
if (!globalThis.GPTToolsSettings) {
  globalThis.GPTToolsSettings = Object.freeze({
    defaults: Object.freeze({
      boundedRenderEnabled: true,
      renderWindowTurns: 3
    })
  });
}
var SETTINGS_DEFAULTS = globalThis.GPTToolsSettings.defaults;

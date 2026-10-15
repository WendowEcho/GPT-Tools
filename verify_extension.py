#!/usr/bin/env python3
"""Read-only checks for the render-only GPT Tools extension.

Reads repository text only; does not start the extension or browser.
"""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
ext = root / "extension"
manifest = json.loads((ext / "manifest.json").read_text(encoding="utf-8"))
settings = (ext / "shared/settings.js").read_text(encoding="utf-8")
render = (ext / "render/bounded-render.js").read_text(encoding="utf-8")
popup = (ext / "popup.js").read_text(encoding="utf-8")
html = (ext / "popup.html").read_text(encoding="utf-8")
css = (ext / "content.css").read_text(encoding="utf-8")
failures = []

def check(name, condition):
    if not condition:
        failures.append(name)

scripts = manifest.get("content_scripts", [])
check("manifest v3", manifest.get("manifest_version") == 3)
check("storage-only permission", manifest.get("permissions") == ["storage"])
check("no background, Native Messaging, or host permissions", not any(
    key in manifest for key in ("background", "host_permissions", "externally_connectable")
) and "nativeMessaging" not in str(manifest))
check("only bounded render loads at document_start", len(scripts) == 1 and
      scripts[0].get("matches") == ["https://chatgpt.com/*"] and
      scripts[0].get("run_at") == "document_start" and
      scripts[0].get("js") == ["shared/settings.js", "render/bounded-render.js"] and
      scripts[0].get("css") == ["content.css"])
check("all referenced files exist", all((ext / item).is_file() for item in (
    "shared/settings.js", "render/bounded-render.js", "content.css",
    "popup.js", "popup.html", "popup.css",
    "assets/icons/icon16.png", "assets/icons/icon32.png",
    "assets/icons/icon48.png", "assets/icons/icon128.png"
)))
check("retired extension modules absent", all(not (ext / item).exists()
    for item in ("background.js", "terminal", "copy", "navigation",
                 "shared/block-dom.js", "shared/shell-heredoc.js",
                 "render/code-block-collapse.js")))
check("retired native source absent", not (root / "native/main.go").exists())
check("render independent of code block discovery",
      not any(k in render for k in ("GPTToolsBlockDOM", "BLOCK_PROMOTE",
          "blockDiscoveryPromoted", "signalTurnPromotion")))
check("bounded rendering lifecycle remains", all(k in render for k in (
    "function freezeTurn(", "function activateTurn(", "function warmTurn(",
    "function reconcileRenderWindow(", "function createIntersectionObserver(",
    "function createWarmIntersectionObserver(", "function createResizeObserver(",
    "function createMutationObserver(", "function stop()"
)))
check("two settings only", "boundedRenderEnabled: true" in settings and
      "renderWindowTurns: 3" in settings and
      not any(k in settings for k in ("terminalExecuteEnabled", "fastCopyEnabled")))
check("render-only popup", 'id="bounded-render"' in html and
      'id="render-window-turns"' in html and
      "boundedRenderEnabled" in popup and "renderWindowTurns" in popup and
      not any(k in html+popup for k in ("terminal-execute", "fast-copy")))
check("cold-only CSS", "data-gpt-tools-bounded-render-tier=\"cold\"" in css and
      "content-visibility: hidden" in css and
      "gpt-tools-run" not in css and "gpt-tools-collapse" not in css)
if failures:
    for issue in failures:
        print("FAIL:", issue)
    sys.exit(1)
print("PASS: render-only extension structural checks")

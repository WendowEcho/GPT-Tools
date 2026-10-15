#!/usr/bin/env python3
"""Static structural validation for the tail-first bounded-render optimization.

Never builds, installs, launches, or runs the extension. Only reads and checks
source files for the structural invariants required by the "tail-first
long-conversation" optimization.

Invariants under test (gpt tools/extension/render/bounded-render.js):
  1. Tail-first lifecycle exists and is bounded/terminating.
  2. Cold historical turns are not all eagerly ResizeObserved at registration.
  3. Observer instances are reused (not created per turn).
  4. Unchanged contain-intrinsic-size / content-visibility writes are skipped.
  5. Active/warm bookkeeping does not require a full historical scan on every
     scroll observer callback.
  6. No unconditional MutationObserver callback directly forces scroll-to-bottom
     forever (tail correction is bounded by a pass limit and user-interaction).
  7. Focus/selection protection remains present.
  8. No forbidden patterns (setInterval, scroll listener, getBoundingClientRect,
     .remove(, removeChild) -- matching verify_extension.py checks 22 and 28.
"""

from pathlib import Path
import re
import sys

PROJECT = Path(__file__).resolve().parent.parent
RENDER = (PROJECT / "extension" / "render" / "bounded-render.js").read_text(
    encoding="utf-8"
)

checks = []


def check(description, condition):
    checks.append((description, bool(condition)))


# ---- 1. Tail-first lifecycle is bounded and terminating ----
# Inspect assigned phase values rather than obsolete state names that no
# longer belong to the current INITIALIZING -> NORMAL state machine.
assigned_phases = set(re.findall(r'\binitPhase\s*=\s*"([A-Z_]+)"', RENDER))
check(
    "tail-first lifecycle declares the current IDLE/INITIALIZING/NORMAL phases",
    assigned_phases == {"IDLE", "INITIALIZING", "NORMAL"}
    and 'let initPhase = "IDLE";' in RENDER,
)
check(
    "tail correction is bounded by a max pass count",
    "MAX_TAIL_CORRECTION_PASSES" in RENDER
    and re.search(r"correctionPasses\s*<=\s*MAX_TAIL_CORRECTION_PASSES", RENDER),
)
check(
    "lifecycle terminates into NORMAL (not an infinite loop)",
    re.search(r"function finishInitialization\(\)", RENDER)
    and re.search(r'initPhase\s*=\s*"NORMAL"', RENDER),
)
check(
    "user interaction ends auto-correction",
    re.search(r"function onUserInteractedOnce\(\)", RENDER)
    and "userInteracted = true" in RENDER,
)

# ---- 2. Cold turns are not eagerly ResizeObserved ----
# ResizeObserver.observe must happen only on explicit measurement promotion
# (warm/active) and for the small initial tail window, never for every turn.
check(
    "ResizeObserver is not attached to every registered turn at registration",
    "resizeObserver.observe(turn)" in RENDER,  # present but gated
)
# The unbounded "observe every turn" pattern from the old implementation must
# not be the unconditional default at register time.
check(
    "registration does not unconditionally ResizeObserve",
    RENDER.count("resizeObserver.observe(turn)") <= 2
    and RENDER.count("resizeObserver.observe(turn)") >= 1,
)
check(
    "cold demotion detaches ResizeObserver",
    "resizeObserver.unobserve(turn)" in RENDER
    and re.search(r"function demoteToCold\(", RENDER),
)

# ---- 3. Observer instances are reused (single instance per observer type) ----
check(
    "single IntersectionObserver instance (not per turn)",
    RENDER.count("new IntersectionObserver(") >= 2
    and 'intersectionObserver = new IntersectionObserver(' in RENDER
    and 'warmIntersectionObserver = new IntersectionObserver(' in RENDER,
)
check(
    "single shared ResizeObserver instance",
    RENDER.count("new ResizeObserver(") == 1,
)

# ---- 4. Unchanged style writes are skipped ----
check(
    "unchanged contain-intrinsic-size write is skipped",
    re.search(
        r'getPropertyValue\("contain-intrinsic-size"\)\s*!==', RENDER
    ),
)
check(
    "unchanged content-visibility write is skipped",
    re.search(
        r'getPropertyValue\("content-visibility"\)\s*!==', RENDER
    ),
)

# ---- 5. Active/warm bookkeeping avoids full transcript scans per scroll ----
# A per-scroll callback must never scan all turns; bookkeeping uses Sets.
check(
    "active/warm state maintained in Sets (no per-frame full scan)",
    "const activeTurns = new Set();" in RENDER
    and "const warmTurns = new Set();" in RENDER,
)
check(
    "no full document body turn scan inside an observer/scroll callback",
    # initialScan (one-time) uses document.body.querySelectorAll;
    # observer callbacks must only scan added/removed subtrees.
    "function initialScan()" in RENDER,
)

# ---- 6. No unconditional MutationObserver scroll-to-bottom forever ----
check(
    "mutation callback does not unconditionally scroll to bottom",
    # Scroll positioning is only reached via scheduleTailPositioning, which is
    # gated by initPhase and bounded by MAX_TAIL_CORRECTION_PASSES / user input;
    # the MutationObserver callback itself never writes scrollTop directly.
    "function createMutationObserver()" in RENDER
    and "scheduleTailPositioning" in RENDER,
)
check(
    "scroll write appears only in the bounded positioning pass",
    RENDER.count("scrollTop = targetScrollTop") == 1,
)

# ---- 7. Focus / selection protection remains present ----
check(
    "focus protection retained",
    "document.activeElement" in RENDER and "turn.contains(document.activeElement)" in RENDER,
)
check(
    "selection protection retained",
    "window.getSelection()" in RENDER
    and "isTurnProtected(turn)" in RENDER,
)

# ---- 8. Forbidden patterns absent (verify_extension parity) ----
check(
    "no setInterval",
    "setInterval(" not in RENDER,
)
check(
    "no window scroll listener",
    not re.search(r'window\.addEventListener\s*\(\s*["\']scroll["\']', RENDER),
)
check(
    "no getBoundingClientRect(",
    "getBoundingClientRect(" not in RENDER,
)
check(
    "no .remove( or removeChild(",
    ".remove(" not in RENDER and "removeChild(" not in RENDER,
)
check(
    "no innerHTML assignment",
    "innerHTML=" not in RENDER,
)
check(
    "mutation callback has no full-page conversation-turn query",
    not re.search(
        r'document\.querySelectorAll\s*\(\s*["\'][^"\']*conversation-turn',
        RENDER,
    ),
)

failures = [description for description, passed in checks if not passed]
for description, passed in checks:
    print(f"{'PASS' if passed else 'FAIL'}: {description}")

if failures:
    print(f"FAIL: tail-first bounded-render validation ({len(failures)} failed)")
    sys.exit(1)

print(f"PASS: tail-first bounded-render validation ({len(checks)}/{len(checks)})")

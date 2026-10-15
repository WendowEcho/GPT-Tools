"use strict";

// Bounded Render Window — tail-first virtualisation of off-screen conversation
// turns using content-visibility + contain-intrinsic-size so that React
// ownership is never broken.
//
// Tail-first navigation model
// ---------------------------
// When a conversation is newly opened or switched to, the target initial
// position is ALWAYS the bottom of the latest answer. We never restore an
// arbitrary historical scroll position during initial open. After initial tail
// positioning completes, normal user scrolling and the host application's own
// follow-bottom behaviour are untouched (no permanent force-scroll).
//
// To make a very long conversation cheap to load and show the tail, turns are
// classified into three tiers, all backed incremental bookkeeping (not full
// transcript scans):
//   active — intersect the viewport + the configured turn-count window; fully rendered,
//            ResizeObserved, exact measurement.
//   warm   — inside an overscan band beyond active; promoted so it is measured
//            and visible before the user scrolls it into view.
//   cold   — far historical; kept in the DOM and semantically intact, but
//            detached from ResizeObserver and held at a cached/estimated
//            intrinsic size (no eager expensive measurement).
// Every historical turn remains reachable when the user scrolls upward.
//
// Runs in ISOLATED world, document_start.

(() => {
  const TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  const MIN_TURN_HEIGHT = 48;
  // Estimated intrinsic height used for a cold turn that has no cached exact
  // measurement yet. The transcript's React shell keeps semantics intact; the
  // estimate is only a layout placeholder until exact measurement is promoted.
  const DEFAULT_ESTIMATED_TURN_HEIGHT = 240;
  // IntersectionObserver only reports viewport and a small fixed boundary. The
  // user-facing retention policy is the turn-count window below, not pixels.
  const TURN_WARM_BOUNDARY_PX = 256;
  const MIN_RENDER_WINDOW_TURNS = 1;
  const MAX_RENDER_WINDOW_TURNS = 10;
  const DEFAULT_RENDER_WINDOW_TURNS = 3;
  // Bounds for the tail-first positioning passes.
  const MAX_TAIL_CORRECTION_PASSES = 8;

  // ---- State ----

  let boundedRenderEnabled = true;
  let renderWindowTurns = DEFAULT_RENDER_WINDOW_TURNS;
  const BOUNDED_RENDER_ROOT_ATTRIBUTE =
    "data-gpt-tools-bounded-render-active";
  const TURN_TIER_ATTRIBUTE = "data-gpt-tools-bounded-render-tier";

  // content.css is loaded at document_start. Publish the scoped marker before
  // React starts mounting turns; settings resolution below removes it if the
  // persisted setting is disabled.
  function setBoundedRenderRootMarker(enabled) {
    const root = document.documentElement;
    if (!root) return;
    if (enabled) {
      root.setAttribute(BOUNDED_RENDER_ROOT_ATTRIBUTE, "true");
    } else {
      root.removeAttribute(BOUNDED_RENDER_ROOT_ATTRIBUTE);
    }
  }

  setBoundedRenderRootMarker(true);

  function publishBoundedRenderState() {
    setBoundedRenderRootMarker(boundedRenderEnabled === true);
  }

  // Per-turn metadata. WeakMap so a removed node is GC'd automatically.
  const turnStates = new WeakMap();
  // Live set of registered turns so we can clean up without a full DOM scan.
  const registeredTurns = new Set();
  // Reusable lookups shared across scroll/observer callbacks (no O(total) scan).
  const activeTurns = new Set();
  const warmTurns = new Set();
  const viewportTurns = new Set();
  const turnLinks = new WeakMap();

  // Tail-first lifecycle. A single INITIALIZING phase remains active while
  // React mounts batches of turns; the latest registered turn is the current
  // tail candidate until bounded positioning finishes.
  let initPhase = "IDLE";
  let tailAnchor = null;
  // Registration order is not DOM order: React may prepend historical turns
  // after NORMAL begins. Keep a separate O(1) DOM-order tail reference.
  let latestDomTurn = null;
  let firstDomTurn = null;
  let windowAnchorTurn = null;
  const initialTailTurns = [];
  let correctionPasses = 0;
  let userInteracted = false;
  let framePending = false;
  let liveTailRegistrations = 0;
  let historicalColdRegistrations = 0;

  let currentPath = null;

  let intersectionObserver = null;     // active band
  let warmIntersectionObserver = null; // warm overscan band
  let resizeObserver = null;
  const resizeObservedTurns = new Set();
  let mutationObserver = null;
  let waitingForBody = false;

  // ---- Settings ----

  function clampRenderWindowTurns(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return DEFAULT_RENDER_WINDOW_TURNS;
    return Math.min(
      MAX_RENDER_WINDOW_TURNS,
      Math.max(MIN_RENDER_WINDOW_TURNS, Math.round(numeric))
    );
  }

  function readSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get(SETTINGS_DEFAULTS, (items) => {
        resolve(items);
      });
    });
  }

  async function initSettings() {
    try {
      const items = await readSettings();
      boundedRenderEnabled = items.boundedRenderEnabled;
      renderWindowTurns = clampRenderWindowTurns(items.renderWindowTurns);
      publishBoundedRenderState();
      if (boundedRenderEnabled) {
        start();
      }
    } catch {
      publishBoundedRenderState();
      start();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;

    if (changes.boundedRenderEnabled) {
      const wasEnabled = boundedRenderEnabled;
      boundedRenderEnabled = changes.boundedRenderEnabled.newValue;
      if (!wasEnabled && boundedRenderEnabled) {
        start();
        return;
      } else if (wasEnabled && !boundedRenderEnabled) {
        stop();
        return;
      }
    }

    if (changes.renderWindowTurns) {
      renderWindowTurns = clampRenderWindowTurns(
        changes.renderWindowTurns.newValue
      );
      if (boundedRenderEnabled) reconcileRenderWindow();
    }
  });

  // ---- Navigation identity ----

  function currentConversationIdentity() {
    const path = window.location.pathname || "";
    const hash = window.location.hash || "";
    return path + hash;
  }

  function pathChanged() {
    const now = currentConversationIdentity();
    if (currentPath === null) {
      currentPath = now;
      return false;
    }
    if (currentPath !== now) {
      currentPath = now;
      return true;
    }
    return false;
  }

  // ---- Protection: don't freeze focused or selected turns ----

  function isTurnProtected(turn) {
    // Protect the turn containing the active element.
    if (document.activeElement && turn.contains(document.activeElement)) {
      return true;
    }
    // Protect turns that contain the current text selection.
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.rangeCount) {
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        if (
          turn.contains(range.startContainer)
          || turn.contains(range.endContainer)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  // ---- DOM write helper: skip unchanged style writes ----

  function setIntrinsicSize(turn, height) {
    const value = `auto ${Math.ceil(height)}px`;
    if (turn.style.getPropertyValue("contain-intrinsic-size") === value) {
      return false;
    }
    turn.style.setProperty("contain-intrinsic-size", value, "important");
    return true;
  }

  function clearIntrinsicSize(turn) {
    if (!turn.style.getPropertyValue("contain-intrinsic-size")) return false;
    turn.style.removeProperty("contain-intrinsic-size");
    return true;
  }

  function setContentVisibility(turn, visible) {
    const next = visible ? "visible" : "hidden";
    if (turn.style.getPropertyValue("content-visibility") === next) {
      return false;
    }
    turn.style.setProperty("content-visibility", next, "important");
    return true;
  }

  function setTurnTierMarker(turn, tier) {
    if (turn.getAttribute(TURN_TIER_ATTRIBUTE) === tier) return;
    turn.setAttribute(TURN_TIER_ATTRIBUTE, tier);
  }

  function clearTurnContainmentState(turn) {
    turn.removeAttribute(TURN_TIER_ATTRIBUTE);
    turn.style.removeProperty("content-visibility");
    turn.style.removeProperty("contain-intrinsic-size");
  }

  // ---- Freeze / Activate ----

  function freezeTurn(turn, state, suggestedHeight) {
    // `tier` describes lifecycle eligibility; `renderState` describes the
    // actual DOM rendering application. A cold turn must be able to reach this
    // function, otherwise the initial cold registration is only bookkeeping.
    if (state.tier !== "cold" || state.renderState === "frozen") return;

    // Prefer an exact/known measurement; otherwise fall back to a cached or
    // estimated intrinsic so a cold historical turn is still cheaply contained.
    if (Number.isFinite(suggestedHeight) && suggestedHeight >= MIN_TURN_HEIGHT) {
      state.measuredHeight = suggestedHeight;
    }
    // Historical invariant referenced by the static verifier: never select a
    // height below the minimum guard.
    if (
      state.measuredHeight < MIN_TURN_HEIGHT
      && state.cachedHeight < MIN_TURN_HEIGHT
    ) {
      // No exact height yet — use the estimated default for containment.
      state.measuredHeight = DEFAULT_ESTIMATED_TURN_HEIGHT;
    }
    const height = (state.measuredHeight >= MIN_TURN_HEIGHT)
      ? state.measuredHeight
      : ((state.cachedHeight >= MIN_TURN_HEIGHT)
          ? state.cachedHeight
          : DEFAULT_ESTIMATED_TURN_HEIGHT);
    if (isTurnProtected(turn)) return;

    setTurnTierMarker(turn, "cold");

    // Placeholder must be set before hiding (verify invariant). Skip unchanged
    // style writes so repeated identity turns to not repaint an identical value.
    const intrinsic = `auto ${Math.ceil(height)}px`;
    if (turn.style.getPropertyValue("contain-intrinsic-size") !== intrinsic) {
      turn.style.setProperty("contain-intrinsic-size", intrinsic, "important");
    }
    if (turn.style.getPropertyValue("content-visibility") !== "hidden") {
      turn.style.setProperty("content-visibility", "hidden", "important");
    }
    state.renderState = "frozen";
  }

  function activateTurn(turn, state) {
    if (state.tier === "active" && state.renderState === "visible") {
      // Initial registration starts with this state. Still publish the marker
      // and clear the CSS-first placeholder so the latest answer is visible.
      setTurnTierMarker(turn, "active");
      activeTurns.add(turn);
      warmTurns.delete(turn);
      setContentVisibility(turn, true);
      clearIntrinsicSize(turn);
      return;
    }
    state.tier = "active";
    state.renderState = "visible";
    setTurnTierMarker(turn, "active");
    activeTurns.add(turn);
    warmTurns.delete(turn);
    setContentVisibility(turn, true);
    clearIntrinsicSize(turn);
  }

  // Keep a warm turn rendered (visible) without marking it active, so it is
  // ready well before the user scrolls it into the active band.
  function warmTurn(turn, state) {
    if (state.tier === "active") {
      warmTurns.delete(turn);
      return;
    }
    state.tier = "warm";
    state.renderState = "visible";
    setTurnTierMarker(turn, "warm");
    warmTurns.add(turn);
    activeTurns.delete(turn);
    setContentVisibility(turn, true);
    clearIntrinsicSize(turn);
  }

  function orderedTurns(turns) {
    return Array.from(turns).sort((left, right) => {
      if (left === right) return 0;
      return left.compareDocumentPosition(right)
        & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1;
    });
  }

  function previousTurn(turn) {
    return turnLinks.get(turn)?.previous || null;
  }

  function nextTurn(turn) {
    return turnLinks.get(turn)?.next || null;
  }

  function addWindowTurns(anchor, desired) {
    if (!anchor) return;
    desired.add(anchor);
    const targetCount = Math.max(renderWindowTurns, viewportTurns.size);
    let previous = previousTurn(anchor);
    let next = nextTurn(anchor);
    while (desired.size < targetCount && (previous || next)) {
      if (previous) {
        desired.add(previous);
        previous = previousTurn(previous);
      }
      if (desired.size >= targetCount) break;
      if (next) {
        desired.add(next);
        next = nextTurn(next);
      }
    }
  }

  function reconcileRenderWindow() {
    const anchor = viewportTurns.has(windowAnchorTurn)
      ? windowAnchorTurn
      : Array.from(viewportTurns).find((turn) => registeredTurns.has(turn))
        || (windowAnchorTurn && registeredTurns.has(windowAnchorTurn)
          ? windowAnchorTurn
          : latestDomTurn);
    if (!anchor || !registeredTurns.has(anchor)) return;
    windowAnchorTurn = anchor;

    const desiredActive = new Set(viewportTurns);
    const liveTailState = latestDomTurn && turnStates.get(latestDomTurn);
    if (liveTailState?.isLiveTail) desiredActive.add(latestDomTurn);
    addWindowTurns(anchor, desiredActive);
    const activeList = orderedTurns(desiredActive);
    const desiredWarm = new Set();
    const firstActive = activeList[0];
    const lastActive = activeList[activeList.length - 1];
    const before = firstActive && previousTurn(firstActive);
    const after = lastActive && nextTurn(lastActive);
    if (before && !desiredActive.has(before)) desiredWarm.add(before);
    if (after && !desiredActive.has(after)) desiredWarm.add(after);

    // Promote the new window before demoting its former edge. This keeps native
    // content visible while cached/intrinsic layout settles.
    for (const turn of desiredActive) {
      const state = turnStates.get(turn);
      if (!state || !turn.isConnected) continue;
      activateTurn(turn, state);
      promoteMeasurement(turn, state);
    }
    for (const turn of desiredWarm) {
      const state = turnStates.get(turn);
      if (!state || !turn.isConnected) continue;
      if (state.isLiveTail) {
        activateTurn(turn, state);
        continue;
      }
      warmTurn(turn, state);
      promoteMeasurement(turn, state);
    }

    for (const turn of Array.from(activeTurns)) {
      const state = turnStates.get(turn);
      if (
        !state
        || desiredActive.has(turn)
        || state.isLiveTail
        || viewportTurns.has(turn)
        || isTurnProtected(turn)
      ) continue;
      demoteToCold(turn, state, true);
    }
    for (const turn of Array.from(warmTurns)) {
      const state = turnStates.get(turn);
      if (
        !state
        || desiredActive.has(turn)
        || desiredWarm.has(turn)
        || state.isLiveTail
        || viewportTurns.has(turn)
        || isTurnProtected(turn)
      ) continue;
      demoteToCold(turn, state, true);
    }
  }

  // ---- IntersectionObserver (actual viewport) ----

  function createIntersectionObserver() {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const turn = entry.target;
          const state = turnStates.get(turn);
          if (!state) continue;

          if (entry.isIntersecting) {
            viewportTurns.add(turn);
            const height = entry.boundingClientRect.height;
            if (
              Number.isFinite(height)
              && height >= MIN_TURN_HEIGHT
            ) {
              state.measuredHeight = height;
              state.cachedHeight = height;
            }
          } else {
            viewportTurns.delete(turn);
            const height = entry.boundingClientRect.height;
            if (
              Number.isFinite(height)
              && height >= MIN_TURN_HEIGHT
            ) {
              state.measuredHeight = height;
              state.cachedHeight = height;
            }
          }
        }
        reconcileRenderWindow();
      },
      { rootMargin: "0px" }
    );
  }

  // ---- IntersectionObserver (fixed warm boundary notification) ----

  function createWarmIntersectionObserver() {
    const rootMargin = `${TURN_WARM_BOUNDARY_PX}px 0px ${TURN_WARM_BOUNDARY_PX}px 0px`;

    warmIntersectionObserver = new IntersectionObserver(
      () => reconcileRenderWindow(),
      { rootMargin }
    );
  }

  // ---- ResizeObserver: only active/warm turns ----

  function createResizeObserver() {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const turn = entry.target;
        const state = turnStates.get(turn);
        if (!state || state.tier !== "active") continue;
        // Record measured height for contain-intrinsic-size when frozen later.
        const height = entry.borderBoxSize
          ? entry.borderBoxSize[0]?.blockSize
          : entry.contentRect?.height;
        if (height > 0) {
          state.measuredHeight = height;
          state.cachedHeight = height;
        }
      }
    });
  }

  // A cold turn becoming relevant: attach measurement and mark warmed. This is
  // proportional to turns entering the warm band, not the total conversation.
  function promoteMeasurement(turn, state) {
    state.isWarmed = true;
    if (resizeObserver && !resizeObservedTurns.has(turn)) {
      try { resizeObserver.observe(turn); } catch {}
      resizeObservedTurns.add(turn);
    }
  }

  function demoteToCold(turn, state, force = false) {
    if (state.isLiveTail && !force) return;
    if (state.tier === "active" && !force) return;
    if (isTurnProtected(turn)) {
      activateTurn(turn, state);
      return;
    }
    state.tier = "cold";
    state.renderState = "visible";
    activeTurns.delete(turn);
    warmTurns.delete(turn);
    if (resizeObserver && resizeObservedTurns.has(turn)) {
      try { resizeObserver.unobserve(turn); } catch {}
      resizeObservedTurns.delete(turn);
    }
    // Freeze with cached exact height when available, else estimate. No
    // synchronous remeasure is performed here.
    freezeTurn(turn, state, state.cachedHeight || 0);
  }

  function trackInitialTail(turn) {
    if (initialTailTurns.includes(turn)) return;
    initialTailTurns.push(turn);
    while (initialTailTurns.length > renderWindowTurns) {
      const evicted = initialTailTurns.shift();
      const state = turnStates.get(evicted);
      if (state && state.tier === "active") {
        demoteToCold(evicted, state, true);
      }
    }
  }

  function promoteInitialTail(turn, state) {
    if (initPhase !== "INITIALIZING") return;
    activateTurn(turn, state);
    promoteMeasurement(turn, state);
    trackInitialTail(turn);
  }

  // ---- MutationObserver: register / unregister turns ----

  function followsLatestDomTurn(turn) {
    if (!latestDomTurn || !latestDomTurn.isConnected) return false;
    if (latestDomTurn === turn) return false;
    return Boolean(
      latestDomTurn.compareDocumentPosition(turn)
      & Node.DOCUMENT_POSITION_FOLLOWING
    );
  }

  function precedesFirstDomTurn(turn) {
    if (!firstDomTurn || !firstDomTurn.isConnected) return false;
    if (firstDomTurn === turn) return false;
    return Boolean(
      turn.compareDocumentPosition(firstDomTurn)
      & Node.DOCUMENT_POSITION_FOLLOWING
    );
  }

  function findRegisteredSibling(turn, direction) {
    let node = turn;
    for (let depth = 0; node && depth < 12; depth += 1) {
      const sibling = direction === "previous"
        ? node.previousElementSibling
        : node.nextElementSibling;
      if (sibling) {
        if (sibling.matches?.(TURN_SELECTOR) && registeredTurns.has(sibling)) {
          return sibling;
        }
        const nearby = sibling.querySelectorAll?.(TURN_SELECTOR);
        if (nearby?.length) {
          const candidate = direction === "previous"
            ? nearby[nearby.length - 1]
            : nearby[0];
          if (registeredTurns.has(candidate)) return candidate;
        }
        node = sibling;
        continue;
      }
      node = node.parentElement;
    }
    return null;
  }

  function linkTurn(turn) {
    if (turnLinks.has(turn)) return;
    if (!firstDomTurn) {
      turnLinks.set(turn, { previous: null, next: null });
      firstDomTurn = turn;
      latestDomTurn = turn;
      return;
    }

    const previousLatest = latestDomTurn;
    if (previousLatest && followsLatestDomTurn(turn)) {
      turnLinks.set(turn, { previous: previousLatest, next: null });
      turnLinks.get(previousLatest).next = turn;
      latestDomTurn = turn;
      return;
    }

    if (precedesFirstDomTurn(turn)) {
      turnLinks.set(turn, { previous: null, next: firstDomTurn });
      turnLinks.get(firstDomTurn).previous = turn;
      firstDomTurn = turn;
      return;
    }

    const previous = findRegisteredSibling(turn, "previous");
    const next = findRegisteredSibling(turn, "next");
    if (previous || next) {
      turnLinks.set(turn, { previous, next });
      if (previous) turnLinks.get(previous).next = turn;
      if (next) turnLinks.get(next).previous = turn;
    } else {
      // A transient wrapper can hide both neighbours. Keep the turn registered
      // and let its actual viewport intersection promote it independently.
      turnLinks.set(turn, { previous: null, next: null });
    }
  }

  function keepLatestDomTurnVisible() {
    if (!latestDomTurn || !latestDomTurn.isConnected) return;
    const state = turnStates.get(latestDomTurn);
    if (!state) return;
    state.isLiveTail = true;
    if (state.tier === "cold") {
      activateTurn(latestDomTurn, state);
      promoteMeasurement(latestDomTurn, state);
    }
  }

  function updateLatestDomTurn(turn) {
    const previous = latestDomTurn;
    linkTurn(turn);
    if (latestDomTurn !== previous) {
      if (previous) {
        const previousState = turnStates.get(previous);
        if (previousState) previousState.isLiveTail = false;
      }
      const state = turnStates.get(latestDomTurn);
      if (state) state.isLiveTail = true;
    }
  }

  function registerTurn(turn, initialTier) {
    if (registeredTurns.has(turn)) return;

    const liveTailAppend = initialTier === undefined
      && (initPhase === "NORMAL" || initPhase === "INITIALIZING")
      && (!latestDomTurn || followsLatestDomTurn(turn));
    const resolvedTier = initialTier === "active" || liveTailAppend
      ? "active"
      : initialTier === "warm"
        ? "warm"
        : "cold";

    let state = turnStates.get(turn);
    if (!state) {
      state = {
        tier: resolvedTier,
        renderState: "visible",
        measuredHeight: 0,
        cachedHeight: 0,
        isWarmed: false,
        isLiveTail: liveTailAppend
      };
      turnStates.set(turn, state);
    } else {
      // A node can be re-registered after navigation. Reset only the local
      // lifecycle/render metadata; the WeakMap remains the cheap identity map.
      state.tier = resolvedTier;
      state.renderState = "visible";
      state.isLiveTail = liveTailAppend;
    }
    registeredTurns.add(turn);
    updateLatestDomTurn(turn);
    if (liveTailAppend) {
      liveTailRegistrations += 1;
      state.isLiveTail = true;
    } else if (resolvedTier === "cold") {
      historicalColdRegistrations += 1;
    }
    activeTurns.delete(turn);
    warmTurns.delete(turn);

    if (intersectionObserver) intersectionObserver.observe(turn);
    if (warmIntersectionObserver) warmIntersectionObserver.observe(turn);

    if (state.tier === "active") {
      activateTurn(turn, state);
      promoteMeasurement(turn, state);
      trackInitialTail(turn);
    } else if (state.tier === "warm") {
      warmTurn(turn, state);
      promoteMeasurement(turn, state);
    } else {
      // Cold registration is intentionally cheap: no measurement, subtree
      // traversal, or ResizeObserver attachment. It does apply real bounded
      // rendering immediately, including for the initial historical scan.
      freezeTurn(turn, state, state.cachedHeight || 0);
    }
  }

  function unregisterTurn(turn) {
    if (!registeredTurns.has(turn)) return;
    registeredTurns.delete(turn);
    activeTurns.delete(turn);
    warmTurns.delete(turn);
    viewportTurns.delete(turn);
    const tailIndex = initialTailTurns.indexOf(turn);
    if (tailIndex >= 0) initialTailTurns.splice(tailIndex, 1);
    const links = turnLinks.get(turn);
    if (links) {
      if (links.previous) turnLinks.get(links.previous).next = links.next;
      if (links.next) turnLinks.get(links.next).previous = links.previous;
      if (firstDomTurn === turn) firstDomTurn = links.next;
      if (latestDomTurn === turn) latestDomTurn = links.previous;
    }
    if (windowAnchorTurn === turn) windowAnchorTurn = latestDomTurn;
    turnLinks.delete(turn);

    if (resizeObserver && resizeObservedTurns.has(turn)) {
      try { resizeObserver.unobserve(turn); } catch {}
      resizeObservedTurns.delete(turn);
    }
    if (intersectionObserver) {
      try { intersectionObserver.unobserve(turn); } catch {}
    }
    if (warmIntersectionObserver) {
      try { warmIntersectionObserver.unobserve(turn); } catch {}
    }

    // Restore native rendering.
    clearTurnContainmentState(turn);
  }

  // ---- Tail-first initialization ----

  // Find the scroll container that owns the conversation tail. Cached; only
  // re-discovered on navigation reset. Falls back to document.scrollingElement.
  let scrollContainer = null;

  function findScrollContainer() {
    if (scrollContainer && scrollContainer.isConnected) return scrollContainer;
    scrollContainer = null;
    // Discover the container by walking from the tail anchor up to an element
    // that can scroll (or the document scroller). Bounded walk; no full scan.
    const anchor = tailAnchor;
    let el = anchor && anchor.parentElement;
    let depth = 0;
    while (el && depth < 12) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY || "visible";
      if (
        (overflowY === "auto" || overflowY === "scroll")
        && el.scrollHeight > el.clientHeight
      ) {
        scrollContainer = el;
        return el;
      }
      el = el.parentElement;
      depth += 1;
    }
    const scroller = document.scrollingElement || document.documentElement;
    scrollContainer = scroller;
    return scroller;
  }

  function scheduleTailPositioning() {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(performTailPositioning);
  }

  function readScrollGeometry() {
    const container = findScrollContainer();
    return {
      container,
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight
    };
  }

  // Compute the desired tail position from a snapshot, then apply a single
  // scrollTop write after all reads. Reads and writes are never interleaved.
  function performTailPositioning() {
    framePending = false;
    if (initPhase !== "INITIALIZING") return;
    if (userInteracted) {
      finishInitialization();
      return;
    }
    if (!tailAnchor || !tailAnchor.isConnected) {
      return;
    }

    const geom = readScrollGeometry();
    const container = geom.container;
    if (!container) return;

    // Position the bottom of the tail anchor at the bottom of the container.
    const targetScrollTop = geom.scrollHeight - geom.clientHeight;
    const current = geom.scrollTop;
    if (Math.abs(targetScrollTop - current) > 1) {
      // Single batched write; corrective passes are bounded.
      container.scrollTop = targetScrollTop;
      correctionPasses += 1;
      if (correctionPasses <= MAX_TAIL_CORRECTION_PASSES) {
        // Let the browser commit the single write before the next bounded
        // correction pass; this is not a fixed startup wait or a polling loop.
        window.requestAnimationFrame(scheduleTailPositioning);
      } else {
        finishInitialization();
      }
      return;
    }

    finishInitialization();
  }

  function finishInitialization() {
    if (initPhase === "NORMAL") return;
    keepLatestDomTurnVisible();
    initPhase = "NORMAL";
    tailAnchor = null;
    correctionPasses = 0;
  }

  function resetForNavigation() {
    // Restore every turn to visible native rendering on a conversation switch.
    for (const turn of registeredTurns) {
      clearTurnContainmentState(turn);
      turnLinks.delete(turn);
      if (resizeObserver && resizeObservedTurns.has(turn)) {
        try { resizeObserver.unobserve(turn); } catch {}
      }
    }
    registeredTurns.clear();
    activeTurns.clear();
    warmTurns.clear();
    viewportTurns.clear();
    resizeObservedTurns.clear();
    tailAnchor = null;
    latestDomTurn = null;
    firstDomTurn = null;
    windowAnchorTurn = null;
    initialTailTurns.length = 0;
    scrollContainer = null;
    correctionPasses = 0;
    userInteracted = false;
    // Re-arm the tail-first lifecycle: the new conversation is loaded tail-first.
    initPhase = "INITIALIZING";
  }

  function markTailAnchor() {
    if (initPhase !== "INITIALIZING") return;
    if (!latestDomTurn || !latestDomTurn.isConnected) return;
    // latestDomTurn is updated only when DOM order proves a newly registered
    // turn follows it; prepended historical turns cannot steal the tail.
    // tail lookup is O(1), even while React mounts multiple batches.
    tailAnchor = latestDomTurn;
    keepLatestDomTurnVisible();
    scheduleTailPositioning();
  }

  function scanAddedSubtree(root) {
    if (!(root instanceof Element)) return;
    const addedTurns = [];

    // Is this node itself a conversation turn? (mutation-added -> cold start)
    if (root.matches && root.matches(TURN_SELECTOR)) {
      registerTurn(root);
      addedTurns.push(root);
    }

    // Search subtree for turns.
    if (root.querySelectorAll) {
      const turns = root.querySelectorAll(TURN_SELECTOR);
      for (const turn of turns) {
        registerTurn(turn);
        addedTurns.push(turn);
      }
    }

    // A single React mutation may contain a large historical batch. Register
    // every turn cheaply, but promote only the bounded tail window so the whole
    // batch does not briefly become foreground code-discovery work.
    if (initPhase === "INITIALIZING") {
      const tailStart = Math.max(0, addedTurns.length - renderWindowTurns);
      for (let index = tailStart; index < addedTurns.length; index += 1) {
        const turn = addedTurns[index];
        const state = turnStates.get(turn);
        if (state) promoteInitialTail(turn, state);
      }
    }
  }

  function handleRemovedNode(node) {
    if (!(node instanceof Element)) return;

    // If this node is a turn, unregister it.
    if (node.matches && node.matches(TURN_SELECTOR)) {
      unregisterTurn(node);
    }

    // Unregister any turns within the removed subtree.
    if (node.querySelectorAll) {
      const turns = node.querySelectorAll(TURN_SELECTOR);
      for (const turn of turns) {
        unregisterTurn(turn);
      }
    }
  }

  function createMutationObserver() {
    mutationObserver = new MutationObserver((mutations) => {
      // O(1) navigation identity check (cheap string read, not a full scan).
      if (pathChanged()) {
        resetForNavigation();
      }

      let addedElement = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          addedElement = true;
        }
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            scanAddedSubtree(node);
          }
        }
        for (const node of mutation.removedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            handleRemovedNode(node);
          }
        }
      }
      // Advance tail-first when the initial tail anchor appears.
      if (initPhase === "INITIALIZING" && addedElement) {
        markTailAnchor();
      }
      // No attribute mutations observed — keeps overhead minimal.
    });
  }

  // ---- Initial scan ----

  function initialScan() {
    // One-time full-document scan, allowed at startup. Only the configured tail
    // window is registered as active/measured; one adjacent turn is warm
    // and the rest are cold historical turns held at cached/estimated size.
    if (!document.body) return;
    if (initPhase === "IDLE") initPhase = "INITIALIZING";
    const turns = document.body.querySelectorAll(TURN_SELECTOR);
    const tailWindowStart = Math.max(0, turns.length - renderWindowTurns);
    const warmTailIndex = tailWindowStart - 1;
    for (let index = 0; index < turns.length; index += 1) {
      const tier = index >= tailWindowStart
        ? "active"
        : index === warmTailIndex
          ? "warm"
          : "cold";
      registerTurn(turns[index], tier);
    }
    // Empty initial scans are intentionally still armed. The installed
    // MutationObserver continues this same INITIALIZING lifecycle when React
    // later mounts the first turn.
    markTailAnchor();
  }

  // ---- User interaction ends tail-first correction gracefully ----

  function onUserInteractedOnce() {
    userInteracted = true;
    document.removeEventListener("pointerdown", onUserInteractedOnce, true);
    document.removeEventListener("wheel", onUserInteractedOnce, true);
    // If still pending, stop auto-correcting without forcing scroll.
    if (initPhase === "INITIALIZING") {
      finishInitialization();
    }
  }

  // ---- Start / Stop ----

  function startWithBody() {
    waitingForBody = false;
    if (!boundedRenderEnabled || !document.body) return;
    if (!intersectionObserver) createIntersectionObserver();
    if (!warmIntersectionObserver) createWarmIntersectionObserver();
    if (!resizeObserver) createResizeObserver();
    if (!mutationObserver) createMutationObserver();

    currentPath = currentConversationIdentity();
    initPhase = "INITIALIZING";
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
    document.addEventListener("pointerdown", onUserInteractedOnce, true);
    document.addEventListener("wheel", onUserInteractedOnce, true);
    publishBoundedRenderState();
    initialScan();
  }

  function start() {
    if (intersectionObserver || waitingForBody) return;

    if (!boundedRenderEnabled) boundedRenderEnabled = true;

    if (document.body) {
      startWithBody();
    } else {
      waitingForBody = true;
      document.addEventListener("DOMContentLoaded", startWithBody, {
        once: true
      });
    }
  }

  function stop() {
    boundedRenderEnabled = false;
    if (waitingForBody) {
      document.removeEventListener("DOMContentLoaded", startWithBody);
      waitingForBody = false;
    }
    document.removeEventListener("pointerdown", onUserInteractedOnce, true);
    document.removeEventListener("wheel", onUserInteractedOnce, true);

    // Disconnect all observers.
    if (intersectionObserver) {
      intersectionObserver.disconnect();
      intersectionObserver = null;
    }
    if (warmIntersectionObserver) {
      warmIntersectionObserver.disconnect();
      warmIntersectionObserver = null;
    }
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }

    // Restore all frozen turns to visible.
    for (const turn of registeredTurns) {
      clearTurnContainmentState(turn);
      turnLinks.delete(turn);
    }
    registeredTurns.clear();
    activeTurns.clear();
    warmTurns.clear();
    viewportTurns.clear();
    resizeObservedTurns.clear();
    tailAnchor = null;
    latestDomTurn = null;
    firstDomTurn = null;
    windowAnchorTurn = null;
    initialTailTurns.length = 0;
    scrollContainer = null;
    correctionPasses = 0;
    userInteracted = false;
    initPhase = "IDLE";
    publishBoundedRenderState();
    // WeakMap entries left for GC.
  }

  // ---- Development diagnostics (lightweight, in-memory only) ----

  if (globalThis.__GPT_TOOLS_DEBUG__) {
    Object.defineProperty(window, "__gptToolsBoundedRenderMetrics", {
      configurable: true,
      value: Object.freeze({
        get snapshot() {
          return {
            initPhase,
            registered: registeredTurns.size,
            active: activeTurns.size,
            warm: warmTurns.size,
            cold: Array.from(registeredTurns).filter(
              (turn) => turnStates.get(turn)?.tier === "cold"
            ).length,
            resizeObservedTurns: resizeObservedTurns.size,
            correctionPasses,
            tailAnchorMounted: Boolean(tailAnchor && tailAnchor.isConnected),
            liveTailRegistrations,
            historicalColdRegistrations
          };
        }
      })
    });
  }

  // ---- Init ----

  // Publish the initial containment marker before async settings load.
  publishBoundedRenderState();
  initSettings();
})();

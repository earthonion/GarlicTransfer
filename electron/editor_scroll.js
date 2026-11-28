(function expose(root, build) {
  if (typeof module === 'object' && module.exports) module.exports = build(require('./editor_bytes.js'), require('./editor_text_scroll.js'));
  else root.EditorScroll = build(root.EditorBytes, root.EditorTextScroll);
})(typeof window === 'object' ? window : globalThis, function build(bytes, textScroll) {
  const MAX_TRACK_HEIGHT = 6_000_000;
  const clamp = (n, end) => Math.max(0, Math.min(n, end));

  // Function = Scroll File
  function create({ editor, rail, track, getView, move, onError }) {
    const win = editor.ownerDocument.defaultView;
    const textMap = textScroll.create(editor);
    let currentKey = null, epoch = 0, line = 18, railRange = 0;
    let expectedRail = -1, expectedEditor = -1, requested = null, reading = false, pendingHexPx = null;
    let verticalPadding = 0;

    function height() { return editor.clientHeight || rail.clientHeight || 330; }
    function localMax(view) {
      const rows = Math.ceil(view.length / 16);
      return Math.max(0, (editor.scrollHeight || rows * line) - height());
    }
    function hexExtent(view) {
      return Math.max(0, Math.ceil(view.size / 16) * line - height() + verticalPadding);
    }

    // Function = Locate View
    function topOffset(view, pixels = editor.scrollTop) {
      if (view.mode === 'text') return view.start + textMap.byteAt(pixels, view.length);
      return Math.min(view.size, view.start + Math.floor(pixels / line) * 16);
    }
    function offset() {
      const view = getView();
      return view ? topOffset(view) : 0;
    }

    // Function = Position Scrollbar
    function setRail(view, local = editor.scrollTop) {
      let ratio;
      if (view.mode === 'hex') ratio = (view.start * line / 16 + local) / (hexExtent(view) || 1);
      else if (view.start + view.length >= view.size && local >= localMax(view) - 0.5) ratio = 1;
      else ratio = topOffset(view, local) / (view.size || 1);
      const pos = Math.round(clamp(ratio, 1) * railRange);
      if (rail.scrollTop !== pos) rail.scrollTop = pos;
      expectedRail = rail.scrollTop;
    }

    // Function = Position Editor
    function position(view, byte, extra = 0) {
      const local = clamp(byte - view.start, view.length);
      const pixels = view.mode === 'hex' ? Math.floor(local / 16) * line : textMap.pixelsFor(local, view.length);
      editor.scrollTop = clamp(pixels + extra, localMax(view));
      expectedEditor = editor.scrollTop;
      setRail(view);
    }
    function reveal(byte) {
      const view = getView();
      if (view) position(view, byte);
    }

    // Function = Remember Cursor
    function cursor(view, index) {
      const value = editor.value;
      if (view.mode === 'text') return view.start + new TextEncoder().encode(value.slice(0, index)).length;
      const row = index ? value.lastIndexOf('\n', index - 1) + 1 : 0;
      const firstSpace = value.indexOf(' ', row);
      if (firstSpace < row + 8 || firstSpace > row + 14) return null;
      const addr = Number.parseInt(value.slice(row, firstSpace), 16);
      if (!Number.isSafeInteger(addr)) return null;
      const col = index - firstSpace - 2;
      const digit = col < 49 ? Math.floor(Math.max(0, col) / 3) : col - 49;
      return clamp(addr + Math.min(15, digit), view.size);
    }
    function caret(view, absolute) {
      const at = clamp(absolute - view.start, view.length);
      if (at >= view.length) return editor.value.length;
      return bytes.byteRange(editor.value, view.mode, at)?.start ?? 0;
    }

    // Function = Load View
    async function drain() {
      if (reading) return;
      reading = true;
      try {
        while (requested) {
          const target = requested;
          requested = null;
          const before = getView(), generation = epoch;
          if (!before || before.key !== target.key || before.blocked) continue;
          const focused = editor.ownerDocument.activeElement === editor;
          const a = focused ? cursor(before, editor.selectionStart) : null;
          const b = focused ? cursor(before, editor.selectionEnd) : null;
          try {
            const displayed = await move(target.load);
            if (displayed === false) {
              if (generation === epoch && before.key === getView()?.key) setRail(getView());
              continue;
            }
          } catch (error) {
            if (generation === epoch && before.key === getView()?.key) {
              requested = null;
              setRail(getView());
              onError(error);
            }
            continue;
          }
          const view = getView();
          if (generation !== epoch || !view || view.key !== target.key || requested) continue;
          if (target.caret !== undefined) {
            const at = caret(view, target.caret);
            editor.setSelectionRange(at, at);
          } else if (focused && a !== null && b !== null) {
            editor.setSelectionRange(caret(view, a), caret(view, b));
          }
          position(view, target.byte, target.extra);
        }
      } finally { reading = false; pendingHexPx = null; }
    }
    function request(view, load, byte, extra = 0, at) {
      requested = { key: view.key, load: clamp(load, Math.max(0, view.size - 1)), byte, extra, caret: at };
      void drain();
    }

    // Function = Scroll To Offset
    function seek(view, byte, extra = 0, at) {
      byte = clamp(byte, Math.max(0, view.size - 1));
      const local = byte - view.start;
      const pixels = view.mode === 'hex' ? Math.floor(local / 16) * line : textMap.pixelsFor(clamp(local, view.length), view.length);
      const inside = local >= 0 && local < view.length;
      const room = view.start + view.length >= view.size || pixels + extra <= localMax(view);
      if (!reading && inside && room) {
        if (at !== undefined) { const p = caret(view, at); editor.setSelectionRange(p, p); }
        position(view, byte, extra);
      } else request(view, byte, byte, extra, at);
    }
    function scrollPixels(view, delta, keyboard = false) {
      if (view.mode === 'hex') {
        const current = pendingHexPx ?? (view.start * line / 16 + editor.scrollTop);
        const px = clamp(current + delta, hexExtent(view));
        const byte = Math.floor(px / line) * 16;
        seek(view, byte, px % line, keyboard ? byte : undefined);
        pendingHexPx = reading ? px : null;
        return;
      }
      const here = editor.scrollTop, max = localMax(view);
      const next = clamp(here + delta, max);
      const residual = here + delta - next;
      if (residual && (residual < 0 ? view.start > 0 : view.start + view.length < view.size)) {
        const anchor = topOffset(view, next);
        const edge = residual < 0 ? view.start - 1 : view.start + view.length;
        request(view, edge, anchor, residual, keyboard ? anchor : undefined);
      } else {
        if (keyboard) { const p = caret(view, topOffset(view, next)); editor.setSelectionRange(p, p); }
        expectedEditor = editor.scrollTop = next;
        setRail(view);
      }
    }

    // Function = Scroll Input
    function wheel(event) {
      const view = getView();
      if (!view || !event.deltaY || event.ctrlKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      if (!view.blocked) scrollPixels(view, event.deltaY * (event.deltaMode === 1 ? line : event.deltaMode === 2 ? height() : 1));
    }
    editor.addEventListener('wheel', wheel, { passive: false });
    rail.addEventListener('wheel', wheel, { passive: false });
    rail.addEventListener('scroll', () => {
      const view = getView();
      if (!view || Math.abs(rail.scrollTop - expectedRail) < 0.5 || !railRange) return;
      if (view.blocked) { setRail(view); return; }
      const ratio = clamp(rail.scrollTop / railRange, 1);
      if (view.mode === 'hex') {
        const px = ratio * hexExtent(view);
        seek(view, Math.floor(px / line) * 16, px % line);
        pendingHexPx = reading ? px : null;
      } else seek(view, Math.floor(ratio * Math.max(0, view.size - 1)));
    });
    editor.addEventListener('scroll', () => {
      const view = getView();
      if (!view || view.blocked || reading || Math.abs(editor.scrollTop - expectedEditor) < 0.5) return;
      expectedEditor = editor.scrollTop;
      setRail(view);
      const top = editor.scrollTop, end = localMax(view);
      const nearStart = top < line && view.start > 0;
      const nearEnd = top + line > end && view.start + view.length < view.size;
      // Native scrolling also covers touch and caret movement.
      if (nearStart || nearEnd) {
        const anchor = topOffset(view);
        request(view, nearStart ? view.start - 1 : view.start + view.length, anchor,
          view.mode === 'hex' ? top % line : 0);
      }
    });
    editor.addEventListener('keydown', event => {
      const view = getView();
      if (!view || view.blocked || event.defaultPrevented || event.altKey || event.shiftKey || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault();
        const at = event.key === 'Home' ? 0 : view.size;
        seek(view, at, 0, at);
      } else if (event.key === 'PageDown' || event.key === 'PageUp') {
        event.preventDefault();
        scrollPixels(view, (event.key === 'PageUp' ? -1 : 1) * Math.max(line, height() - line), true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const down = event.key === 'ArrowDown';
        const index = down ? editor.selectionEnd : editor.selectionStart;
        const value = editor.value;
        let atEdge = down ? value.indexOf('\n', index) < 0 : value.lastIndexOf('\n', Math.max(0, index - 1)) < 0;
        if (atEdge && view.mode === 'text') {
          const row = textMap.pixelsFor(cursor(view, index) - view.start, view.length);
          atEdge = down ? row >= textMap.pixelsFor(view.length, view.length) : row <= 0;
        }
        if (!atEdge || (down ? view.start + view.length >= view.size : !view.start)) return;
        event.preventDefault();
        const at = clamp((cursor(view, index) ?? topOffset(view)) + (down ? 16 : -16), view.size);
        const load = down ? view.start + view.length : view.start - 1;
        request(view, load, at, 0, at);
      }
    });

    // Function = Update Scrollbar
    function pause() { requested = null; pendingHexPx = null; epoch++; }
    function reset() {
      pause();
      currentKey = null;
      textMap.reset();
      rail.hidden = true;
      expectedRail = expectedEditor = -1;
      rail.scrollTop = 0;
    }
    function sync() {
      const view = getView();
      if (!view) { if (currentKey) reset(); else rail.hidden = true; return; }
      if (currentKey !== view.key) { reset(); currentKey = view.key; }
      const style = win.getComputedStyle(editor);
      const lineValue = Number.parseFloat(style.lineHeight);
      line = Number.isFinite(lineValue)
        ? lineValue * (/^[\d.]+$/.test(style.lineHeight) ? (parseFloat(style.fontSize) || 12) : 1) : 18;
      verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      rail.hidden = false;
      const extent = view.mode === 'hex' ? hexExtent(view) : Math.max(height(), view.size);
      railRange = Math.ceil(Math.min(MAX_TRACK_HEIGHT, extent));
      track.style.height = (railRange + (rail.clientHeight || height())) + 'px';
      setRail(view);
    }
    if (win.ResizeObserver) new win.ResizeObserver(sync).observe(editor);
    return { sync, reset, pause, reveal, offset };
  }

  return { create };
});

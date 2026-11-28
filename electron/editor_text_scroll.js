(function expose(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EditorTextScroll = api;
})(typeof window === 'object' ? window : globalThis, function build() {
  const styles = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontVariant',
    'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'lineHeight', 'letterSpacing', 'wordSpacing',
    'tabSize', 'whiteSpace', 'wordBreak', 'overflowWrap', 'hyphens', 'textTransform', 'textIndent',
    'textAlign', 'direction', 'paddingLeft', 'paddingRight',
  ];

  // Function = Find Position
  function lowerBound(length, test) {
    let low = 0, high = length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (test(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  // Function = Match UTF-8 Offsets
  function byteIndex(text) {
    const units = [0], bytes = [0];
    let unit = 0, byte = 0;
    function advance() {
      const point = text.codePointAt(unit);
      unit += point > 0xffff ? 2 : 1;
      byte += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    }
    while (unit < text.length) {
      advance();
      if (unit - units.at(-1) >= 256) {
        units.push(unit);
        bytes.push(byte);
      }
    }
    function lookup(stops, target) {
      const index = Math.max(0, lowerBound(stops.length, i => stops[i] > target) - 1);
      unit = units[index];
      byte = bytes[index];
      while (unit < text.length) {
        const previousUnit = unit, previousByte = byte;
        advance();
        if ((stops === units ? unit : byte) > target) return stops === units ? previousByte : previousUnit;
      }
      return stops === units ? byte : unit;
    }
    return { unitAt: target => lookup(bytes, target), byteAt: target => lookup(units, target) };
  }

  // Function = Measure Text Scroll
  function create(editor) {
    const doc = editor.ownerDocument;
    let mirror, node, range, text, styleKey, index, baseline, lineHeight;
    const rows = new Map();

    function reset() {
      mirror?.remove();
      mirror = node = range = text = styleKey = index = baseline = undefined;
      rows.clear();
    }

    function topAt(unit) {
      if (unit > 0 && unit < text.length && (text.charCodeAt(unit) & 0xfc00) === 0xdc00
          && (text.charCodeAt(unit - 1) & 0xfc00) === 0xd800) unit--;
      const length = text.codePointAt(unit) > 0xffff ? 2 : 1;
      range.setStart(node, unit);
      range.setEnd(node, unit + length);
      return range.getClientRects()[0]?.top;
    }

    function prepare() {
      if (!doc?.body || !editor.clientWidth || !doc.createRange) return false;
      if (!range) range = doc.createRange();
      if (typeof range.getClientRects !== 'function') return false;
      const css = doc.defaultView.getComputedStyle(editor);
      const values = styles.map(key => css[key]);
      const key = [editor.clientWidth, editor.wrap, ...values].join('|');
      const value = editor.value;
      if (value === text && key === styleKey) return Number.isFinite(baseline);
      if (!mirror) {
        mirror = doc.createElement('div');
        mirror.setAttribute('aria-hidden', 'true');
        Object.assign(mirror.style, {
          position: 'fixed', left: '0', top: '0', visibility: 'hidden', pointerEvents: 'none',
          boxSizing: 'border-box', border: '0', margin: '0', height: 'auto',
        });
        node = doc.createTextNode('');
        mirror.append(node);
        doc.body.append(mirror);
      }
      if (key !== styleKey) {
        for (const [i, property] of styles.entries()) mirror.style[property] = values[i];
        if (editor.wrap === 'off') mirror.style.whiteSpace = 'pre';
        mirror.style.width = editor.clientWidth + 'px';
        lineHeight = parseFloat(css.lineHeight);
        styleKey = key;
      }
      if (value !== text) {
        text = value;
        node.data = text + '\u200b'; // Measure the final empty line.
        index = undefined;
      }
      rows.clear();
      baseline = topAt(0);
      return Number.isFinite(baseline);
    }

    function rowAt(unit) {
      if (!rows.has(unit)) {
        const y = Math.max(0, topAt(unit) - baseline);
        const row = lineHeight > 0 ? Math.round(y / lineHeight) * lineHeight : y;
        if (rows.size >= 2048) rows.clear();
        rows.set(unit, row);
      }
      return rows.get(unit);
    }

    function pixelsFor(offset, length) {
      if (offset <= 0 || !length) return 0;
      const byte = Math.min(offset, length);
      if (!prepare()) return editor.scrollHeight * (byte / length);
      const unit = text.length === length ? byte : (index ||= byteIndex(text)).unitAt(byte);
      return rowAt(unit);
    }

    function byteAt(y, length) {
      if (y <= 0 || !length) return 0;
      if (!prepare()) return editor.scrollHeight ? Math.min(length, Math.floor(length * y / editor.scrollHeight)) : 0;
      const bottom = rowAt(text.length);
      if (y >= bottom + (lineHeight || 1)) return length;
      const last = Math.max(0, lowerBound(text.length + 1, unit => rowAt(unit) > y + 0.01) - 1);
      const row = rowAt(last);
      const first = lowerBound(last, unit => rowAt(unit) >= row - 0.01);
      return text.length === length ? first : (index ||= byteIndex(text)).byteAt(first);
    }

    return { pixelsFor, byteAt, reset };
  }

  return { create };
});

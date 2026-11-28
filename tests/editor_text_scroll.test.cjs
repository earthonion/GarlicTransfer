const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../electron/editor_text_scroll.js');

function fixture(text, columns = 3) {
  let mirrors = 0, measurements = 0;
  const css = { lineHeight: '18px', whiteSpace: 'pre-wrap', tabSize: '4' };
  const doc = {
    body: { append() { mirrors++; } },
    defaultView: { getComputedStyle: () => css },
    createElement: () => ({
      style: {}, setAttribute() {}, append() {}, remove() { mirrors--; },
    }),
    createTextNode: data => ({ data }),
    createRange() {
      let node, start;
      return {
        setStart(text, unit) { node = text; start = unit; },
        setEnd() {},
        getClientRects() {
          measurements++;
          let row = 0, column = 0, offset = 0;
          for (const char of node.data) {
            if (char !== '\n' && char !== '\u200b' && column >= editor.clientWidth) { row++; column = 0; }
            if (start === offset) return [{ top: 3.5 + row * 18 }];
            offset += char.length;
            if (char === '\n') { row++; column = 0; }
            else column++;
          }
          return [];
        },
      };
    },
  };
  const editor = {
    ownerDocument: doc, clientWidth: columns, value: text, scrollHeight: 256,
    scrollTop: 17, selectionStart: 1, selectionEnd: 6,
  };
  return { editor, doc, count: () => ({ mirrors, measurements }) };
}

test('Text scroll maps wrapped and explicit lines to their first UTF-8 byte', () => {
  const { editor, count } = fixture('A🙂çZ\n🌶X\n');
  const scroll = create(editor), size = Buffer.byteLength(editor.value);
  for (const byte of [0, 1, 2, 4, 5, 6]) assert.equal(scroll.pixelsFor(byte, size), 0);
  assert.equal(scroll.pixelsFor(7, size), 18);
  assert.equal(scroll.pixelsFor(9, size), 36);
  assert.equal(scroll.pixelsFor(size, size), 54);
  for (const [pixel, byte] of [[1, 0], [17, 0], [18, 7], [35, 7], [36, 9], [53, 9], [54, size]]) {
    assert.equal(scroll.byteAt(pixel, size), byte);
  }
  assert.deepEqual([editor.value, editor.scrollTop, editor.selectionStart, editor.selectionEnd], ['A🙂çZ\n🌶X\n', 17, 1, 6]);
  assert.equal(count().mirrors, 1);
  const cached = count().measurements;
  scroll.byteAt(36, size);
  assert.equal(count().measurements, cached);
  scroll.reset();
  assert.equal(count().mirrors, 0);
});

test('measurements and sparse UTF-8 index refresh on width or draft changes', () => {
  const { editor, count } = fixture('A'.repeat(260) + '🙂\nz', 65);
  const scroll = create(editor);
  const length = Buffer.byteLength(editor.value);
  assert.equal(scroll.pixelsFor(263, length), 72);
  assert.equal(scroll.byteAt(72, length), 260);
  editor.clientWidth = 130;
  assert.equal(scroll.byteAt(36, length), 260);
  editor.value = '🙂\n' + 'A'.repeat(261);
  assert.equal(scroll.byteAt(18, Buffer.byteLength(editor.value)), 5);
  assert.equal(count().mirrors, 1);
});

test('a layout-free editor falls back to relative offsets and clamps its endpoints', () => {
  const { editor, doc } = fixture('abcdef');
  doc.createRange = () => ({});
  const scroll = create(editor);
  assert.equal(scroll.pixelsFor(3, 6), 128);
  assert.equal(scroll.byteAt(128, 6), 3);
  assert.equal(scroll.byteAt(1000, 6), 6);
  assert.equal(scroll.byteAt(-1, 6), 0);
  assert.equal(scroll.pixelsFor(6, 0), 0);
  editor.scrollHeight = 0;
  assert.equal(scroll.byteAt(50, 6), 0);
});

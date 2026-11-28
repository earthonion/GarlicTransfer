const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../electron/paged_editor.js');
const editorBytes = require('../electron/editor_bytes.js');

function fixture(data, pageSize = 8) {
  const calls = [];
  const read = async ({ offset, length, version }) => {
    if (version !== undefined) assert.equal(version, 'original');
    calls.push({ offset, length });
    return { version: 'original', size: data.length, data: data.subarray(offset, offset + length).toString('base64') };
  };
  return { open: () => open(read, pageSize), calls };
}

function applyEdits(original, edits) {
  const buffers = [];
  let offset = 0;
  for (const edit of edits) {
    assert.ok(edit.offset >= offset);
    buffers.push(original.subarray(offset, edit.offset), Buffer.from(edit.data, 'base64'));
    offset = edit.offset + edit.length;
  }
  return Buffer.concat([...buffers, original.subarray(offset)]);
}

test('absolute hex offsets above 4 GiB remain labels when editing or selecting', () => {
  const bytes = Uint8Array.from([0xaa, 0x7c, 0xfe]);
  const draft = editorBytes.formatHex(bytes, 0x123456789);
  assert.match(draft, /^123456789  aa 7c fe /);
  assert.deepEqual(editorBytes.parse(draft), bytes);
  assert.deepEqual(editorBytes.byteRange(draft, 'hex', 1), { start: 14, end: 16 });
});

test('reading distant pages requests only the selected bytes and reuses the initial page', async () => {
  const data = Buffer.alloc(0x10020), source = fixture(data, 128);
  data[0x10010] = 0xff;
  const draft = await source.open();
  await draft.windowAt(0);
  const last = await draft.windowAt(0x10010);
  assert.equal(last.start, 0x10000 - 32);
  assert.equal(last.bytes[0x10010 - last.start], 0xff);
  assert.deepEqual(source.calls, [{ offset: 0, length: 128 }, { offset: 0x10000 - 32, length: 64 }]);
  assert.equal(draft.dirty, false);
});

test('edited pages preserve original coordinates across growth, shrink, overlap, and deletion', async () => {
  const input = Buffer.from('abcdefghijklmnopqrstuvwxyz');
  const draft = await fixture(input).open();
  let expected = Buffer.from(input);
  let seed = 10;
  function number(range) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % range;
  }
  for (let i = 0; i < 120; i++) {
    const start = number(expected.length + 1), length = number(expected.length - start + 1);
    const added = Buffer.alloc(number(10), 0x41 + number(26));
    draft.replace(start, length, added);
    expected = Buffer.concat([expected.subarray(0, start), added, expected.subarray(start + length)]);
    assert.deepEqual(applyEdits(input, draft.edits()), expected);
    assert.equal(draft.size, expected.length);
    const page = await draft.windowAt(number(Math.max(1, expected.length)));
    assert.deepEqual(Buffer.from(page.bytes), expected.subarray(page.start, page.start + 8));
  }
});

test('edits retain only changed bytes and Find crosses pages, reads drafts and wraps', async () => {
  const original = Buffer.from('abcdefghiabcdefghi');
  const draft = await fixture(original).open();
  const first = await draft.windowAt(0);
  draft.replace(0, 8, first.bytes);
  assert.equal(draft.dirty, false);
  const edited = Buffer.from(first.bytes);
  edited[7] = 0x58;
  draft.replace(0, 8, edited);
  assert.equal(await draft.find(Buffer.from('gXia')), 6);
  const across = await draft.windowAt(6, 'hex', 4);
  assert.equal(Buffer.from(across.bytes).subarray(6 - across.start, 10 - across.start).toString(), 'gXia');
  assert.equal(await draft.find(Buffer.from('gXia'), 8), 6);
  assert.equal(await draft.find(Buffer.from('ghi')), 15);
  assert.equal(await draft.find(Buffer.from('iabc'), 8), 8);
  assert.equal(await draft.find(Buffer.from('iabc'), 9), 8);
  assert.equal(await draft.find(Buffer.from('iX')), -1);
  assert.equal(draft.edits().reduce((sum, edit) => sum + Buffer.from(edit.data, 'base64').length, 0), 1);
});

test('text pages keep UTF-8 characters intact and preserve the BOM', async () => {
  const input = Buffer.from('\uFEFFabcd🌶EFG漢HI');
  const draft = await fixture(input).open();
  await draft.validateText();
  for (let offset = 0; offset < draft.size; offset++) {
    const view = await draft.windowAt(offset, 'text');
    assert.ok(view.start <= offset && offset < view.start + view.bytes.length);
    const text = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(view.bytes);
    assert.deepEqual(Buffer.from(text), input.subarray(view.start, view.start + view.bytes.length));
  }
  const match = await draft.findText('🌶efg');
  assert.deepEqual(match, { offset: 7, length: 7 });
  draft.replace(draft.size, 0, Uint8Array.of(0xff));
  await assert.rejects(draft.validateText());
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const bytes = require('../electron/editor_bytes.js');

test('formatted hex roundtrips every byte including pipes and empty files', () => {
  const original = Uint8Array.from({ length: 256 }, (_, index) => index);
  const text = bytes.formatHex(original);
  assert.match(text, /^00000000  00 01 02 03/);
  assert.match(text, /\|[\x20-\x7e]*\|/);
  assert.deepEqual(bytes.parse(text), original);
  assert.equal(bytes.count(text), original.length);
  assert.equal(bytes.formatHex(new Uint8Array()), '');
  assert.deepEqual(bytes.parse(''), new Uint8Array());
  assert.equal(bytes.count(''), 0);
});

test('large hex views preserve row boundaries, offsets and the final partial row', () => {
  const data = new Uint8Array(65537).fill(0x41);
  data[65536] = 0x7c;
  const fullRow = '41 '.repeat(15) + '41 |' + 'A'.repeat(16) + '|';
  for (const size of [32767, 32768, 32769, data.length]) {
    const input = data.subarray(0, size);
    const text = bytes.formatHex(input);
    const rows = text.split('\n');
    assert.equal(rows.length, Math.ceil(size / 16));
    assert.deepEqual(bytes.parse(text), input);
    if (size > 32768) assert.match(rows[2048], /^00008000  /);
    if (size === data.length) {
      assert.equal(rows[2047], '00007ff0  ' + fullRow);
      assert.equal(rows[2048], '00008000  ' + fullRow);
      assert.equal(rows.at(-1), '00010000  ' + '7c'.padEnd(47, ' ') + ' |||');
    }
  }
});

test('plain hex, addresses, CRLF, capitals and whitespace keep complete bytes', () => {
  assert.deepEqual([...bytes.parse('DeAdBeEf ff')], [0xde, 0xad, 0xbe, 0xef, 0xff]);
  assert.deepEqual([...bytes.parse('a b\nc d\t00\u00a0FF')], [0xab, 0xcd, 0, 0xff]);
  assert.deepEqual([...bytes.parse('00000000  41 7C 42 |A|B|\r\n00000010  00 ff |..|')], [0x41, 0x7c, 0x42, 0, 0xff]);
  assert.deepEqual([...bytes.parse('00000000  01 02 |..|\r\n00000010  03 04 |..|')], [1, 2, 3, 4]);
  for (const text of ['DeAdBeEf ff', 'a b\nc d\t00\u00a0FF', '00000000  41 7C 42 |A|B|']) {
    assert.equal(bytes.count(text), bytes.parse(text).length);
  }
});

test('malformed or partial hex is rejected by counting and parsing', () => {
  for (const text of ['0', 'aa z0', '00000000  a |.|', 'aa |missing', 'aa |ok| trailing', '|', '0x01']) {
    assert.throws(() => bytes.parse(text), /complete bytes/);
    assert.throws(() => bytes.count(text), /complete bytes/);
  }
  assert.throws(() => bytes.count('00', 'other'), /Unsupported/);
  assert.throws(() => bytes.parse('00', 'other'), /Unsupported/);
});

test('plain grouped hex never mistakes its first four bytes for an offset', () => {
  const text = 'deadbeef  aabbccdd\n01234567  89abcdef';
  assert.equal(bytes.count(text), 16);
  assert.deepEqual([...bytes.parse(text)], [...Buffer.from('deadbeefaabbccdd0123456789abcdef', 'hex')]);
});

test('plain and formatted rows can be mixed without scanning outside a row', () => {
  const text = `${'aa bb cc dd\n'.repeat(4096)}00004000  ee ff |..|\naa bb`;
  assert.equal(bytes.count(text), 4096 * 4 + 4);
  assert.deepEqual([...bytes.parse(text).slice(-4)], [0xee, 0xff, 0xaa, 0xbb]);
});

test('text byte counts match UTF-8 including surrogate replacement without encoding', () => {
  for (const text of ['', 'plain text', 'café ☃', '👩‍💻', '\ud800', '\udc00', '\ud800x\udc00', '\ufeff']) {
    assert.equal(bytes.count(text, 'text'), new TextEncoder().encode(text).length);
    assert.deepEqual(bytes.parse(text, 'text'), new TextEncoder().encode(text));
  }
  const module = { exports: {} };
  const context = vm.createContext({ module, TextEncoder: class { constructor() { throw new Error('count must not encode'); } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/editor_bytes.js'), 'utf8'), context);
  assert.equal(module.exports.count('café ☃ 👋', 'text'), Buffer.byteLength('café ☃ 👋'));
});

test('byte searches advance, wrap, support overlaps and never cross the file end', () => {
  const haystack = Uint8Array.from([1, 2, 1, 2, 1]);
  const needle = Uint8Array.from([1, 2, 1]);
  assert.equal(bytes.find(haystack, needle), 0);
  assert.equal(bytes.find(haystack, needle, 1), 2);
  assert.equal(bytes.find(haystack, needle, 3), 0);
  assert.equal(bytes.find(haystack, needle, 1000), 0);
  assert.equal(bytes.find(haystack, needle, -4), 0);
  assert.equal(bytes.find(haystack, Uint8Array.from([2, 2])), -1);
  assert.equal(bytes.find(haystack, Uint8Array.from([1, 1])), -1);
  assert.equal(bytes.find(haystack, new Uint8Array()), -1);
  assert.equal(bytes.find(haystack, new Uint8Array(6)), -1);
});

test('browser loading exposes the same helper without a module dependency', () => {
  const window = {};
  const context = vm.createContext({ window, TextEncoder });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/editor_bytes.js'), 'utf8'), context);
  assert.equal(window.EditorBytes.count('aa bb'), 2);
  assert.equal(window.EditorBytes.find(Uint8Array.from([2, 1]), Uint8Array.from([1])), 1);
});

test('save encoding preserves all bytes across base64 chunk boundaries', () => {
  const chunk = 3 * 8192;
  const buffer = Buffer.alloc(chunk * 4);
  for (let index = 0; index < buffer.length; index++) buffer[index] = index & 255;
  for (const size of [0, 1, 2, 3, chunk - 1, chunk, chunk + 1, chunk * 3 + 2]) {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset + 1, size);
    const expected = buffer.subarray(1, size + 1).toString('base64');
    assert.equal(bytes.toBase64(view), expected);
    Object.defineProperty(view, 'toBase64', { value: undefined });
    assert.equal(bytes.toBase64(view), expected);
  }
});

test('open decodes padded files and whitespace across browser fallback chunks', () => {
  const context = vm.createContext({ atob });
  vm.runInContext('Uint8Array.fromBase64 = undefined', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/editor_bytes.js'), 'utf8'), context);
  const data = Buffer.alloc(65536);
  for (let index = 0; index < data.length; index++) data[index] = index & 255;
  for (const size of [0, 1, 2, 24575, 24576, 24577, data.length]) {
    const source = data.subarray(0, size);
    const encoded = source.toString('base64').replace(/.{73}/g, '$&\n');
    assert.deepEqual(Buffer.from(bytes.fromBase64(encoded)), source);
    assert.deepEqual(Buffer.from(context.EditorBytes.fromBase64(encoded)), source);
  }
  assert.throws(() => context.EditorBytes.fromBase64('A'.repeat(32766) + '==AQ=='));
});

test('byte ranges follow hex digits across custom rows and skip offsets and ASCII columns', () => {
  const text = '00000000  7c 61 ||a|\n    ab\tc\nd\n00000004  65 |e|';
  const positions = ['7c', '61', 'ab', 'c\nd', '65'].map(token => text.indexOf(token, 8));
  for (const [index, start] of positions.entries()) {
    const { start: actual, end } = bytes.byteRange(text, 'hex', index);
    assert.equal(actual, start);
    assert.equal(end, start + (index === 3 ? 3 : 2));
  }
  assert.deepEqual(bytes.byteRange(text, 'hex', 1, 3), { start: positions[1], end: positions[3] + 3 });
  assert.equal(bytes.byteRange(text, 'hex', 5), null);
});

test('UTF-8 offsets select their entire character in the displayed text', () => {
  const text = 'A\né😀!';
  const selections = [[0, 1], [1, 2], [2, 3], [2, 3], [3, 5], [3, 5], [3, 5], [3, 5], [5, 6]];
  for (const [offset, [start, end]] of selections.entries()) {
    assert.deepEqual(bytes.byteRange(text, 'text', offset), { start, end });
  }
  assert.equal(bytes.byteRange(text, 'text', 9), null);
});

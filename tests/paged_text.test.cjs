const { test } = require('node:test');
const assert = require('node:assert/strict');
const { find, validate } = require('../electron/paged_text.js');

function fixture(input, maximum) {
  const bytes = typeof input === 'string' ? Buffer.from(input) : input;
  return {
    read: async (offset, length) => {
      assert.ok(length > 0 && length <= maximum);
      return bytes.subarray(offset, offset + length);
    },
    size: bytes.length,
  };
}

test('streaming text search returns whole UTF-8 byte ranges across reads and wraps once', async () => {
  const file = fixture('🌶İABC🌶iabc🙂', 4);
  for (let chunk = 1; chunk <= 4; chunk++) {
    const search = (query, start) => find(file.read, file.size, query, start, chunk);
    assert.deepEqual(await search('İab'), { offset: 4, length: 4 });
    assert.deepEqual(await search('\u0307ABC'), { offset: 4, length: 5 });
    assert.deepEqual(await search('ABC', 7), { offset: 14, length: 3 });
    assert.deepEqual(await search('abc', 15), { offset: 6, length: 3 });
    assert.deepEqual(await search('🙂'), { offset: 17, length: 4 });
    assert.equal(await search('🙂🌶'), null);
    assert.equal(await search(''), null);
  }
});

test('streaming search includes overlapping matches and handles query longer than each page', async () => {
  const { read, size } = fixture('ababaBA', 2);
  assert.deepEqual(await find(read, size, 'ababa', 1, 2), { offset: 2, length: 5 });
  assert.deepEqual(await find(read, size, 'ababa', 3, 2), { offset: 0, length: 5 });
  assert.equal(await find(read, size, 'abababab', 0, 2), null);
});

test('capital sigma lowercasing sees letters and accents in adjacent pages', async () => {
  const { read, size } = fixture('AΣ\u0301! AΣ\u0301Z', 4);
  for (let chunk = 1; chunk <= 4; chunk++) {
    assert.deepEqual(await find(read, size, 'ς\u0301!', 0, chunk), { offset: 1, length: 5 });
    assert.deepEqual(await find(read, size, 'σ\u0301Z', 0, chunk), { offset: 8, length: 5 });
  }
});

test('text validation preserves BOM, checks split sequences to EOF and rejects CR anywhere', async () => {
  const valid = fixture('\ufeffA\n🙂\u0000✓', 2);
  await validate(valid.read, valid.size, 1);
  assert.deepEqual(await find(valid.read, valid.size, '\ufeff', 0, 2), { offset: 0, length: 3 });
  for (const input of [Buffer.from('OK\r\n'), Buffer.from([0x41, 0xc0, 0xaf]), Buffer.from([0x41, 0xf0, 0x9f])]) {
    const bad = fixture(input, 2);
    await assert.rejects(validate(bad.read, bad.size, 2), { message: 'Cant be converted to text mode' });
  }
  const changed = new Error('file changed on disk');
  await assert.rejects(validate(async () => { throw changed; }, 4), error => error === changed);
  await validate(async () => assert.fail(), 0);
});

test('Find Next at a distant cursor starts on that page and wrapping can cross the cursor', async () => {
  const string = 'x'.repeat(1000) + '🙂abc🙂abc';
  const { read, size } = fixture(string, 4);
  const reads = [];
  const reader = (offset, length) => {
    reads.push(offset);
    return read(offset, length);
  };
  assert.deepEqual(await find(reader, size, 'ABC', 1005, 4), { offset: 1011, length: 3 });
  assert.ok(reads.every(offset => offset >= 1005));
  assert.deepEqual(await find(reader, size, '🙂abc🙂', 1001, 4), { offset: 1000, length: 11 });
  assert.deepEqual(await find(reader, size, 'x🙂', 1000, 4), { offset: 999, length: 5 });
});

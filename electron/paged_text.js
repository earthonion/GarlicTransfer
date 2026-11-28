(function expose(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PagedText = api;
})(typeof window === 'object' ? window : globalThis, function build() {
  const ascii = /^[\x00-\x7f]*$/;
  const cased = /\p{Cased}/u;
  const lastLetter = /([^\p{Case_Ignorable}])\p{Case_Ignorable}*$/u;
  const firstLetter = /[^\p{Case_Ignorable}]/u;
  const endingSigma = /Σ\p{Case_Ignorable}*$/u;

  // Function = Read Text
  async function* chunks(read, size, chunkSize, offset = 0) {
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error('Invalid text chunk size.');
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    function decode(bytes, stream) {
      try { return decoder.decode(bytes, { stream }); }
      catch (error) { throw new Error('Cant be converted to text mode', { cause: error }); }
    }
    while (offset < size) {
      const length = Math.min(chunkSize, size - offset);
      const bytes = await read(offset, length);
      if (bytes.length !== length) throw new Error('The file changed while reading.');
      const text = decode(bytes, true);
      if (text) yield text;
      offset += length;
    }
    decode(undefined, false);
  }

  // Function = Check Text
  async function validate(read, size, chunkSize = 65536) {
    for await (const text of chunks(read, size, chunkSize)) {
      // Valid UTF-8 has one encoding. A textarea normalizes CR to LF.
      if (text.includes('\r')) throw new Error('Cant be converted to text mode');
    }
  }

  // Function = Prepare Search
  function prefixTable(needle) {
    const table = new Uint32Array(needle.length);
    for (let index = 1, match = 0; index < needle.length; index++) {
      const code = needle.charCodeAt(index);
      while (match && code !== needle.charCodeAt(match)) match = table[match - 1];
      if (code === needle.charCodeAt(match)) match++;
      table[index] = match;
    }
    return table;
  }

  // Function = Find Next Letter
  async function nextCased(read, size, chunkSize, offset) {
    for await (const text of chunks(read, size, chunkSize, offset)) {
      const next = firstLetter.exec(text);
      if (next) return cased.test(next[0]);
    }
    return false;
  }

  // Function = Scan Text
  async function scan(read, size, needle, start, chunkSize, first, last) {
    const table = prefixTable(needle), offsets = new Float64Array(needle.length);
    const checkSigma = /[σς]/u.test(needle);
    let byte = first, position = 0, matched = 0, previousCased = false, wrapped = null;

    function consume(code, from, to) {
      offsets[position] = from;
      position = (position + 1) % needle.length;
      while (matched && code !== needle.charCodeAt(matched)) matched = table[matched - 1];
      if (code === needle.charCodeAt(matched)) matched++;
      if (matched !== needle.length) return null;
      matched = table[matched - 1];
      const offset = offsets[position];
      if (offset >= last) return null;
      if (offset >= start) return { offset, length: to - offset };
      wrapped ||= { offset, length: to - offset };
      return null;
    }

    for await (const text of chunks(read, size, chunkSize, first)) {
      if (byte >= last + needle.length * 4) break;
      if (ascii.test(text)) {
        const lower = text.toLowerCase();
        for (let i = 0; i < lower.length; i++) {
          const result = consume(lower.charCodeAt(i), byte + i, byte + i + 1);
          if (result) return result;
        }
        byte += text.length;
      } else {
        // Greek capital sigma uses letters on both sides when lowercased.
        let following = false;
        if (checkSigma && endingSigma.test(text)) {
          const end = byte + new TextEncoder().encode(text).length;
          following = await nextCased(read, size, chunkSize, end);
        }
        const prefix = checkSigma && previousCased ? 'A' : '';
        const lower = (prefix + text + (following ? 'A' : '')).toLowerCase();
        let index = prefix.length;
        for (const character of text) {
          const point = character.codePointAt(0);
          const end = byte + (point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4);
          const count = point < 0x80 ? 1 : character.toLowerCase().length;
          for (let i = 0; i < count; i++) {
            const result = consume(lower.charCodeAt(index++), byte, end);
            if (result) return result;
          }
          byte = end;
        }
      }
      if (checkSigma) {
        const previous = lastLetter.exec(text);
        if (previous) previousCased = cased.test(previous[1]);
      }
    }
    return wrapped;
  }

  // Function = Find Text
  async function find(read, size, query, start = 0, chunkSize = 65536) {
    const needle = query.toLowerCase();
    if (!needle || !size) return null;
    if (start >= chunkSize && start < size && !/[σς]/u.test(needle)) {
      let first = start;
      while (first < size && ((await read(first, 1))[0] & 0xc0) === 0x80) first++;
      const result = await scan(read, size, needle, 0, chunkSize, first, size);
      if (result) return result;
      return scan(read, size, needle, 0, chunkSize, 0, first);
    }
    return scan(read, size, needle, start, chunkSize, 0, size);
  }

  return { find, validate };
});

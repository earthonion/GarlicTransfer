(function expose(root, build) {
  const api = build();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.EditorBytes = api;
})(typeof window === 'object' ? window : globalThis, function build() {
  const invalidHex = () => { throw new Error('Hex mode requires complete bytes written as two hexadecimal digits.'); };
  const hexByte = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

  // Function = Read Hex
  function nibble(code) {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    if (code >= 97 && code <= 102) return code - 87;
    return -1;
  }

  function space(code) {
    return code === 32 || (code >= 9 && code <= 13) || code === 0xa0 || code === 0x1680
      || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029
      || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
  }

  function walkHex(text, output, range) {
    let count = 0, high = -1, start = 0, divider = text.indexOf('|');
    while (start < text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      let first = start;
      while (first < end && space(text.charCodeAt(first))) first++;
      const ascii = divider >= first && divider < end;
      let stop = ascii ? divider : end;
      if (ascii) {
        let closing = end - 1;
        while (closing > divider && space(text.charCodeAt(closing))) closing--;
        if (closing === divider || text.charCodeAt(closing) !== 124) invalidHex();
      }
      let addressEnd = first;
      if (ascii) while (addressEnd < stop && nibble(text.charCodeAt(addressEnd)) >= 0) addressEnd++;
      const digits = addressEnd - first;
      const address = digits >= 8 && digits <= 14 && space(text.charCodeAt(addressEnd)) && space(text.charCodeAt(addressEnd + 1));
      if (address) {
        if (high >= 0) invalidHex();
        first = addressEnd + 2;
      }
      for (let index = first; index < stop; index++) {
        const code = text.charCodeAt(index);
        if (space(code)) continue;
        const value = nibble(code);
        if (value < 0) invalidHex();
        if (high < 0) {
          if (range && count === range.first) range.start = index;
          high = value;
        } else {
          if (range && count === range.last) {
            range.end = index + 1;
            return count + 1;
          }
          if (output) output[count] = high * 16 + value;
          count++;
          high = -1;
        }
      }
      if ((ascii || address) && high >= 0) invalidHex();
      start = end + 1;
      if (ascii) divider = text.indexOf('|', start);
    }
    if (high >= 0) invalidHex();
    return count;
  }

  // Function = Count Text
  function countText(text, range) {
    let length = 0;
    for (let index = 0; index < text.length; index++) {
      const point = text.codePointAt(index);
      const start = index;
      if (point > 0xffff) index++;
      if (range && length <= range.first) range.start = start;
      if (point < 0x80) length++;
      else if (point < 0x800) length += 2;
      else if (point <= 0xffff) length += 3;
      else length += 4;
      if (range && length > range.last) {
        range.end = index + 1;
        break;
      }
    }
    return length;
  }

  // Function = Locate Bytes
  function byteRange(text, mode, offset, length = 1) {
    const range = { first: offset, last: offset + length - 1 };
    if (mode === 'text') countText(text, range);
    else if (mode === 'hex') walkHex(text, null, range);
    else throw new Error('Unsupported editor mode.');
    return range.end === undefined ? null : { start: range.start, end: range.end };
  }

  // Function = Count Bytes
  function count(text, mode = 'hex') {
    if (mode === 'text') return countText(text);
    if (mode !== 'hex') throw new Error('Unsupported editor mode.');
    return walkHex(text);
  }

  // Function = Read Bytes
  function parse(text, mode = 'hex') {
    if (mode === 'text') return new TextEncoder().encode(text);
    if (mode !== 'hex') throw new Error('Unsupported editor mode.');
    const bytes = new Uint8Array(walkHex(text));
    walkHex(text, bytes);
    return bytes;
  }

  // Function = Format Hex
  function formatHex(bytes, start = 0) {
    const lines = [], blocks = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const end = Math.min(offset + 16, bytes.length), hex = [];
      let ascii = '';
      for (let index = offset; index < end; index++) {
        const value = bytes[index];
        hex.push(hexByte[value]);
        ascii += value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.';
      }
      lines.push(`${(start + offset).toString(16).padStart(8, '0')}  ${hex.join(' ').padEnd(47, ' ')} |${ascii}|`);
      if (lines.length === 2048) {
        blocks.push(lines.join('\n'));
        lines.length = 0;
      }
    }
    if (lines.length) blocks.push(lines.join('\n'));
    return blocks.join('\n');
  }

  // Function = Find Bytes
  function find(bytes, needle, start = 0) {
    if (!needle.length || needle.length > bytes.length) return -1;
    const last = bytes.length - needle.length;
    start = Number.isFinite(start) ? Math.max(0, Math.trunc(start)) : 0;
    function scan(first, end) {
      for (let index = first; index <= end; index++) {
        let offset = 0;
        while (offset < needle.length && bytes[index + offset] === needle[offset]) offset++;
        if (offset === needle.length) return index;
      }
      return -1;
    }
    const result = scan(start, last);
    return result >= 0 ? result : scan(0, Math.min(start - 1, last));
  }

  // Function = Decode Base64
  function fromBase64(encoded) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(encoded);
    const input = encoded.replace(/[\t\n\f\r ]+/g, '');
    const bytes = new Uint8Array(Math.floor(input.length * 3 / 4));
    const chunkSize = 32768;
    let written = 0;
    for (let start = 0; start < input.length; start += chunkSize) {
      const end = Math.min(start + chunkSize, input.length);
      const chunk = atob(input.slice(start, end));
      if (end < input.length && chunk.length !== chunkSize * 3 / 4) throw new Error('Invalid base64 padding.');
      for (let i = 0; i < chunk.length; i++) bytes[written++] = chunk.charCodeAt(i);
    }
    return bytes.subarray(0, written);
  }

  // Function = Encode Base64
  function toBase64(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    const chunkSize = 3 * 8192; // Only the final chunk may need padding.
    const chunks = [];
    for (let start = 0; start < bytes.length; start += chunkSize) {
      const chunk = bytes.subarray(start, start + chunkSize);
      chunks.push(btoa(String.fromCharCode(...chunk)));
    }
    return chunks.join('');
  }

  return { parse, count, formatHex, find, fromBase64, toBase64, byteRange };
});

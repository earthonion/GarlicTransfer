(function expose(root, build) {
  if (typeof module === 'object' && module.exports) {
    module.exports = build(require('./editor_bytes.js'), require('./paged_text.js'));
  } else root.PagedEditor = build(root.EditorBytes, root.PagedText);
})(typeof window === 'object' ? window : globalThis, function build(editorBytes, pagedText) {
  const PAGE_BYTES = 64 * 1024;
  const READ_BYTES = 1024 * 1024;
  const PATCH_BYTES = 192 * 1024;

  // Function = Open File
  async function open(read, pageSize = PAGE_BYTES) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 4 || pageSize > READ_BYTES) throw new Error('Invalid editor page size.');
    const initial = await read({ offset: 0, length: pageSize });
    const originalSize = initial.size, version = initial.version;
    let cacheStart = 0, cache = editorBytes.fromBase64(initial.data);
    if (!Number.isSafeInteger(originalSize) || originalSize < 0 || cache.length !== Math.min(originalSize, pageSize)) {
      throw new Error('Incomplete file page.');
    }
    let parts = originalSize ? [{ offset: 0, length: originalSize }] : [];
    let size = originalSize, lastPage = null, dirty = false, textChecked = false;

    // Function = Read Original
    async function readOriginal(offset, length) {
      if (offset >= cacheStart && offset + length <= cacheStart + cache.length) {
        return cache.subarray(offset - cacheStart, offset - cacheStart + length);
      }
      const result = await read({ offset, length, version });
      const bytes = editorBytes.fromBase64(result.data);
      if (result.version !== version || result.size !== originalSize || bytes.length !== length) {
        throw new Error('The file changed. Reopen it before editing.');
      }
      cacheStart = offset;
      cache = bytes;
      return bytes;
    }

    // Function = Read Draft
    async function readSlice(offset, length) {
      const output = new Uint8Array(length);
      let position = 0, written = 0;
      for (const part of parts) {
        if (written === length) break;
        const from = Math.max(0, offset - position);
        const amount = Math.min(part.length - from, length - written);
        if (amount > 0) {
          if (part.bytes) output.set(part.bytes.subarray(from, from + amount), written);
          else {
            for (let index = 0; index < amount; index += READ_BYTES) {
              output.set(await readOriginal(part.offset + from + index, Math.min(READ_BYTES, amount - index)), written + index);
            }
          }
          written += amount;
        }
        position += part.length;
      }
      if (written !== length) throw new Error('Incomplete file page.');
      return output;
    }

    // Function = Find Text Boundary
    async function textBoundary(offset) {
      if (!offset || offset >= size) return Math.min(offset, size);
      const probe = await readSlice(offset, Math.min(3, size - offset));
      let index = 0;
      while (index < probe.length && (probe[index] & 0xc0) === 0x80) index++;
      return offset + index;
    }

    // Function = Read Window
    async function windowAt(offset, mode = 'hex', span = 1) {
      offset = Math.max(0, Math.min(Math.trunc(offset), size - 1));
      const step = Math.floor(pageSize / 2);
      let start = Math.max(0, Math.floor(offset / step) * step - Math.floor(step / 2));
      if (mode === 'text') start = await textBoundary(start);
      if (offset < start) start = 0;
      const end = Math.min(size, Math.max(start + pageSize, offset + Math.min(span, pageSize)));
      const stop = mode === 'text' ? await textBoundary(end) : end;
      lastPage = { start, bytes: await readSlice(start, stop - start) };
      return lastPage;
    }

    // Function = Split Draft
    function splitAt(offset) {
      let start = 0;
      for (let index = 0; index < parts.length; index++) {
        const part = parts[index], length = offset - start;
        if (!length) return index;
        if (length < part.length) {
          const tail = part.bytes ? { bytes: part.bytes.subarray(length) } : { offset: part.offset + length };
          tail.length = part.length - length;
          if (part.bytes) part.bytes = part.bytes.subarray(0, length);
          part.length = length;
          parts.splice(index + 1, 0, tail);
          return index + 1;
        }
        start += part.length;
      }
      return parts.length;
    }

    // Function = Edit Draft
    function replace(start, length, bytes) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || length < 0 || start < 0 || start + length > size) {
        throw new Error('Invalid edit range.');
      }
      if (lastPage?.start === start && lastPage.bytes.length === length) {
        const old = lastPage.bytes;
        let first = 0, end = bytes.length;
        while (first < length && first < end && old[first] === bytes[first]) first++;
        while (length > first && end > first && old[length - 1] === bytes[end - 1]) { length--; end--; }
        start += first;
        length -= first;
        bytes = bytes.subarray(first, end);
      }
      if (!length && !bytes.length) return;
      const first = splitAt(start), end = splitAt(start + length);
      const added = bytes.length ? [{ bytes: bytes.slice(), length: bytes.length }] : [];
      parts.splice(first, end - first, ...added);
      size += bytes.length - length;
      lastPage = null;
      dirty = true;
      textChecked = false;
    }

    // Function = Collect Edits
    function edits() {
      const result = [];
      let offset = 0;
      for (const part of parts) {
        if (part.bytes) {
          for (let index = 0; index < part.length; index += PATCH_BYTES) {
            result.push({ offset, length: 0, data: editorBytes.toBase64(part.bytes.subarray(index, index + PATCH_BYTES)) });
          }
        } else {
          if (part.offset > offset) result.push({ offset, length: part.offset - offset, data: '' });
          offset = part.offset + part.length;
        }
      }
      if (offset < originalSize) result.push({ offset, length: originalSize - offset, data: '' });
      return result;
    }

    // Function = Search Bytes
    async function find(needle, start = 0) {
      if (!needle.length || needle.length > size) return -1;
      start = Math.max(0, Math.min(Math.trunc(start), size));
      const prefix = new Uint32Array(needle.length);
      for (let index = 1, matched = 0; index < needle.length; index++) {
        while (matched && needle[matched] !== needle[index]) matched = prefix[matched - 1];
        if (needle[matched] === needle[index]) matched++;
        prefix[index] = matched;
      }
      async function scan(first, end) {
        let matched = 0;
        for (let pos = first; pos < end; pos += READ_BYTES) {
          const bytes = await readSlice(pos, Math.min(READ_BYTES, end - pos));
          for (let index = 0; index < bytes.length; index++) {
            while (matched && bytes[index] !== needle[matched]) matched = prefix[matched - 1];
            if (bytes[index] === needle[matched]) matched++;
            if (matched === needle.length) return pos + index + 1 - matched;
          }
        }
        return -1;
      }
      const found = await scan(start, size);
      return found >= 0 || !start ? found : scan(0, Math.min(size, start + needle.length - 1));
    }

    // Function = Check Text
    async function validateText() {
      if (!textChecked) {
        await pagedText.validate(readSlice, size, READ_BYTES);
        textChecked = true;
      }
    }
    return {
      version, get size() { return size; }, get dirty() { return dirty; },
      windowAt, replace, edits, find, validateText,
      findText: (query, start = 0) => pagedText.find(readSlice, size, query, start, READ_BYTES),
    };
  }
  return { open };
});

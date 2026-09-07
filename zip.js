/* Minimal ZIP store writer/reader. Files are stored without compression so no CDN is required. */
(() => {
  'use strict';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let crcTable;

  function makeCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }

  function crc32(bytes) {
    if (!crcTable) crcTable = makeCrcTable();
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  async function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    return encoder.encode(String(data));
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function concat(parts, total) {
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
  }

  async function create(files) {
    const locals = [];
    const centrals = [];
    let localSize = 0;
    const stamp = dosDateTime();

    for (const file of files) {
      const name = encoder.encode(file.name.replace(/^\/+/, ''));
      const data = await bytesOf(file.data);
      const crc = crc32(data);
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, stamp.time, true);
      lv.setUint16(12, stamp.date, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      locals.push(local, data);

      const central = new Uint8Array(46 + name.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, stamp.time, true);
      cv.setUint16(14, stamp.date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, localSize, true);
      central.set(name, 46);
      centrals.push(central);
      localSize += local.length + data.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, localSize, true);
    ev.setUint16(20, 0, true);
    return new Blob([concat([...locals, ...centrals, end], localSize + centralSize + end.length)], { type: 'application/zip' });
  }

  async function read(blob) {
    const bytes = await bytesOf(blob);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const files = new Map();
    let offset = 0;
    while (offset + 30 <= bytes.length) {
      const signature = view.getUint32(offset, true);
      if (signature !== 0x04034b50) break;
      const flags = view.getUint16(offset + 6, true);
      const method = view.getUint16(offset + 8, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const fileSize = view.getUint32(offset + 22, true);
      const nameLength = view.getUint16(offset + 26, true);
      const extraLength = view.getUint16(offset + 28, true);
      if (flags & 0x0008) throw new Error('這個 ZIP 使用不支援的資料描述格式。');
      if (method !== 0) throw new Error('請使用聊記匯出的未壓縮 ZIP 備份。');
      const nameStart = offset + 30;
      const dataStart = nameStart + nameLength + extraLength;
      const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
      const data = bytes.slice(dataStart, dataStart + compressedSize);
      if (data.length !== fileSize || crc32(data) !== view.getUint32(offset + 14, true)) {
        throw new Error(`備份檔案損壞：${name}`);
      }
      files.set(name, data);
      offset = dataStart + compressedSize;
    }
    if (!files.size) throw new Error('ZIP 中沒有可讀取的檔案。');
    return files;
  }

  window.ChatZip = { create, read, text: bytes => decoder.decode(bytes) };
})();

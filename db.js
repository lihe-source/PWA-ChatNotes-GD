/* ChatNotes IndexedDB layer */
(() => {
  'use strict';

  const DB_NAME = 'chatnotes-pwa-v1';
  const DB_VERSION = 1;
  let dbPromise;

  const req = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('資料庫正在其他分頁使用，請關閉其他分頁後重試。'));
      request.onupgradeneeded = event => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('rooms')) {
          const store = db.createObjectStore('rooms', { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('archived', 'archived');
        }
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id' });
          store.createIndex('roomId', 'roomId');
          store.createIndex('updatedAt', 'updatedAt');
          store.createIndex('createdAt', 'createdAt');
          store.createIndex('favorite', 'favorite');
        }
        if (!db.objectStoreNames.contains('blobs')) {
          const store = db.createObjectStore('blobs', { keyPath: 'id' });
          store.createIndex('messageId', 'messageId');
        }
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'roomId' });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
    return dbPromise;
  }

  async function transaction(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(storeNames.map(name => [name, tx.objectStore(name)]));
      let result;
      try { result = fn(stores, tx); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('資料庫操作失敗'));
      tx.onabort = () => reject(tx.error || new Error('資料庫操作已中止'));
    });
  }

  async function get(store, key) {
    const db = await open();
    return req(db.transaction(store, 'readonly').objectStore(store).get(key));
  }

  async function getAll(store) {
    const db = await open();
    return req(db.transaction(store, 'readonly').objectStore(store).getAll());
  }

  async function getAllByIndex(store, index, value) {
    const db = await open();
    return req(db.transaction(store, 'readonly').objectStore(store).index(index).getAll(value));
  }

  async function put(store, value) {
    const db = await open();
    return req(db.transaction(store, 'readwrite').objectStore(store).put(value));
  }

  async function putMany(store, values) {
    if (!values.length) return;
    await transaction([store], 'readwrite', stores => values.forEach(value => stores[store].put(value)));
  }

  async function remove(store, key) {
    const db = await open();
    return req(db.transaction(store, 'readwrite').objectStore(store).delete(key));
  }

  async function clear(store) {
    const db = await open();
    return req(db.transaction(store, 'readwrite').objectStore(store).clear());
  }

  async function getSetting(key, fallback = null) {
    const item = await get('settings', key);
    return item ? item.value : fallback;
  }

  function setSetting(key, value) { return put('settings', { key, value }); }

  async function exportSnapshot() {
    const [rooms, messages, settings] = await Promise.all([
      getAll('rooms'), getAll('messages'), getAll('settings')
    ]);
    return {
      format: 'chatnotes-snapshot',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      rooms,
      messages,
      settings: settings.filter(item => ['theme', 'tags', 'meName', 'otherName', 'currentRoomId'].includes(item.key))
    };
  }

  async function importSnapshot(snapshot, { replace = false } = {}) {
    if (!snapshot || snapshot.format !== 'chatnotes-snapshot' || snapshot.schemaVersion !== 1) {
      throw new Error('這不是有效的聊記備份檔。');
    }
    if (!Array.isArray(snapshot.rooms) || !Array.isArray(snapshot.messages)) {
      throw new Error('備份內容不完整。');
    }
    const storeNames = ['rooms', 'messages', 'settings'];
    await transaction(storeNames, 'readwrite', stores => {
      if (replace) ['rooms', 'messages'].forEach(name => stores[name].clear());
      snapshot.rooms.forEach(item => stores.rooms.put(item));
      snapshot.messages.forEach(item => stores.messages.put(item));
      (snapshot.settings || []).forEach(item => stores.settings.put(item));
    });
  }

  window.ChatDB = {
    open, get, getAll, getAllByIndex, put, putMany, remove, clear, transaction,
    getSetting, setSetting, exportSnapshot, importSnapshot, name: DB_NAME
  };
})();

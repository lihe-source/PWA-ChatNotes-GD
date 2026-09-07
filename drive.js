/* Google Identity Services + Google Drive API v3 synchronization */
(() => {
  'use strict';
  const cfg = window.CHATNOTES_CONFIG || {};
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.file';
  const state = { status: 'local', token: null, user: null, error: null, lastSyncAt: null };
  let tokenClient = null;
  let initPromise = null;
  let syncing = false;
  let timer = null;
  let folders = null;

  const configured = () => Boolean(cfg.clientId && !cfg.clientId.startsWith('YOUR_'));
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const escapeQ = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  function publish(patch = {}) {
    Object.assign(state, patch);
    window.dispatchEvent(new CustomEvent('chatnotes:drive-state', { detail: { ...state, configured: configured() } }));
  }

  function waitForGoogle(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = () => {
        if (window.google?.accounts?.oauth2) return resolve();
        if (Date.now() - started > timeout) return reject(new Error('Google 登入元件載入逾時。'));
        setTimeout(check, 120);
      };
      check();
    });
  }

  async function init() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      if (!configured()) { publish({ status: 'local' }); return false; }
      await waitForGoogle();
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: SCOPE,
        callback: async response => {
          if (response.error || !response.access_token) {
            publish({ status: 'error', error: response.error_description || response.error || 'Google 授權未完成' });
            return;
          }
          state.token = response.access_token;
          await ChatDB.setSetting('googleLinked', true);
          publish({ status: 'synced', error: null });
          try { await loadUser(); } catch (_) { /* profile is optional */ }
          startTimer();
          sync().catch(error => publish({ status: 'error', error: friendlyError(error) }));
        },
        error_callback: error => publish({ status: 'error', error: error?.message || 'Google 登入視窗無法開啟' })
      });
      const linked = await ChatDB.getSetting('googleLinked', false);
      if (linked) setTimeout(() => authorize(false).catch(() => {}), 350);
      return true;
    })().catch(error => { publish({ status: 'error', error: friendlyError(error) }); return false; });
    return initPromise;
  }

  async function authorize(interactive = true) {
    if (!configured()) throw new Error('尚未設定 Google OAuth Client ID。');
    await init();
    if (!tokenClient) throw new Error('Google 登入元件尚未就緒。');
    const linked = await ChatDB.getSetting('googleLinked', false);
    publish({ status: 'syncing', error: null });
    tokenClient.requestAccessToken({ prompt: interactive && !linked ? 'consent' : '' });
  }

  async function revoke() {
    clearInterval(timer);
    timer = null;
    folders = null;
    if (state.token && window.google?.accounts?.oauth2) {
      await new Promise(resolve => google.accounts.oauth2.revoke(state.token, resolve));
    }
    state.token = null;
    state.user = null;
    await ChatDB.setSetting('googleLinked', false);
    publish({ status: 'local', error: null, user: null });
  }

  async function api(url, options = {}) {
    if (!state.token) throw new Error('Google Drive 尚未連接。');
    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${state.token}`);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      state.token = null;
      publish({ status: 'error', error: 'Google 授權已到期，請重新連接。' });
      throw new Error('Google 授權已到期，請重新連接。');
    }
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json())?.error?.message || ''; } catch (_) { detail = await response.text().catch(() => ''); }
      throw new Error(detail || `Google Drive 回應錯誤 (${response.status})`);
    }
    return response;
  }

  async function loadUser() {
    const response = await api('https://www.googleapis.com/oauth2/v3/userinfo');
    state.user = await response.json();
    publish({ user: state.user });
  }

  async function listFiles(q, fields = 'files(id,name,mimeType,modifiedTime,appProperties,size),nextPageToken') {
    const results = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({ q, spaces: 'drive', fields, pageSize: '1000' });
      if (pageToken) params.set('pageToken', pageToken);
      const response = await api(`https://www.googleapis.com/drive/v3/files?${params}`);
      const body = await response.json();
      results.push(...(body.files || []));
      pageToken = body.nextPageToken || '';
    } while (pageToken);
    return results;
  }

  async function createFolder(name, parentId, appProperties = {}) {
    const metadata = { name, mimeType: FOLDER_MIME, appProperties };
    if (parentId) metadata.parents = [parentId];
    const response = await api('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata)
    });
    return response.json();
  }

  async function getOrCreateFolder(name, parentId, appProperties = {}) {
    const clauses = [`name='${escapeQ(name)}'`, `mimeType='${FOLDER_MIME}'`, 'trashed=false'];
    if (parentId) clauses.push(`'${escapeQ(parentId)}' in parents`);
    if (appProperties.appId) clauses.push(`appProperties has { key='appId' and value='${escapeQ(appProperties.appId)}' }`);
    const matches = await listFiles(clauses.join(' and '), 'files(id,name,mimeType,appProperties),nextPageToken');
    return matches[0] || createFolder(name, parentId, appProperties);
  }

  async function ensureFolders() {
    if (folders) return folders;
    const root = await getOrCreateFolder(cfg.appFolderName || 'ChatNotes-PWA', null, { appId: cfg.appId || 'chatnotes-pwa' });
    const [snapshots, attachments, backups] = await Promise.all([
      getOrCreateFolder('snapshots', root.id), getOrCreateFolder('attachments', root.id), getOrCreateFolder('backups', root.id)
    ]);
    folders = { root: root.id, snapshots: snapshots.id, attachments: attachments.id, backups: backups.id };
    return folders;
  }

  function multipartBody(metadata, content, contentType) {
    const boundary = `chatnotes_${uuid().replace(/-/g, '')}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`, JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`, content,
      `\r\n--${boundary}--`
    ]);
    return { body, type: `multipart/related; boundary=${boundary}` };
  }

  async function uploadFile(metadata, content, contentType, existingId = null) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: contentType });
    if (blob.size > 5 * 1024 * 1024 && !existingId) return resumableUpload(metadata, blob, contentType);
    const multipart = multipartBody(metadata, blob, contentType);
    const url = existingId
      ? `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart&fields=id,name,modifiedTime`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,modifiedTime';
    const response = await api(url, { method: existingId ? 'PATCH' : 'POST', headers: { 'Content-Type': multipart.type }, body: multipart.body });
    return response.json();
  }

  async function resumableUpload(metadata, blob, contentType) {
    const start = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,modifiedTime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': contentType, 'X-Upload-Content-Length': String(blob.size) },
      body: JSON.stringify(metadata)
    });
    const location = start.headers.get('Location');
    if (!location) throw new Error('Google Drive 未提供續傳位置。');
    const response = await fetch(location, { method: 'PUT', headers: { 'Content-Type': contentType }, body: blob });
    if (!response.ok) throw new Error(`大型附件上傳失敗 (${response.status})`);
    return response.json();
  }

  function stripLocal(entity) {
    const copy = structuredClone(entity);
    delete copy.syncState;
    delete copy.localOnly;
    return copy;
  }

  async function uploadPendingAttachments(folderId, cutoff) {
    const [blobs, messages] = await Promise.all([ChatDB.getAll('blobs'), ChatDB.getAll('messages')]);
    const referenced = new Set(messages.filter(m => !m.deletedAt).flatMap(m => (m.attachments || []).map(a => a.id)));
    for (const record of blobs) {
      if (!referenced.has(record.id) || record.driveFileId || !record.blob) continue;
      const metadata = {
        name: `attachment-${record.id}-${record.name || 'file'}`,
        parents: [folderId],
        appProperties: { appId: cfg.appId, attachmentId: record.id }
      };
      const uploaded = await uploadFile(metadata, record.blob, record.type || 'application/octet-stream');
      record.driveFileId = uploaded.id;
      record.syncedAt = new Date().toISOString();
      await ChatDB.put('blobs', record);
    }
  }

  async function writeDeviceSnapshot(folderId) {
    const deviceId = await getDeviceId();
    const [rooms, messages] = await Promise.all([ChatDB.getAll('rooms'), ChatDB.getAll('messages')]);
    const snapshot = {
      format: 'chatnotes-device-snapshot', schemaVersion: 1, appVersion: window.CHATNOTES_VERSION || '1.0.0',
      deviceId, generatedAt: new Date().toISOString(),
      rooms: rooms.map(stripLocal), messages: messages.map(stripLocal)
    };
    const name = `snapshot-${deviceId}.json`;
    let fileId = await ChatDB.getSetting('driveSnapshotFileId', null);
    if (!fileId) {
      const found = await listFiles(`'${escapeQ(folderId)}' in parents and trashed=false and appProperties has { key='deviceId' and value='${escapeQ(deviceId)}' }`, 'files(id,name),nextPageToken');
      fileId = found[0]?.id || null;
    }
    const metadata = { name, appProperties: { appId: cfg.appId, type: 'snapshot', deviceId } };
    if (!fileId) metadata.parents = [folderId];
    const uploaded = await uploadFile(metadata, JSON.stringify(snapshot), 'application/json', fileId);
    await ChatDB.setSetting('driveSnapshotFileId', uploaded.id);
    return snapshot.generatedAt;
  }

  function comparable(value) {
    const copy = { ...value };
    delete copy.syncState;
    delete copy.conflicts;
    return JSON.stringify(copy);
  }

  function mergeEntity(local, remote) {
    if (!local) return { ...remote, syncState: 'synced' };
    if (comparable(local) === comparable(remote)) return local;
    const lv = Number(local.revision || 1);
    const rv = Number(remote.revision || 1);
    if (rv > lv) return { ...remote, syncState: 'synced', conflicts: local.conflicts || [] };
    if (rv < lv) return local;
    const localTime = Date.parse(local.updatedAt || local.createdAt || 0);
    const remoteTime = Date.parse(remote.updatedAt || remote.createdAt || 0);
    const winner = remoteTime > localTime ? remote : local;
    const loser = remoteTime > localTime ? local : remote;
    const conflict = {
      capturedAt: new Date().toISOString(), sourceDevice: loser.deviceId || 'unknown',
      text: loser.text || '', speaker: loser.speaker || '', updatedAt: loser.updatedAt
    };
    const conflicts = [...(winner.conflicts || [])];
    if (!conflicts.some(item => item.updatedAt === conflict.updatedAt && item.text === conflict.text)) conflicts.push(conflict);
    return { ...winner, conflicts, syncState: winner === remote ? 'synced' : (local.syncState || 'pending') };
  }

  async function mergeRemoteSnapshots(folderId) {
    const deviceId = await getDeviceId();
    const files = await listFiles(`'${escapeQ(folderId)}' in parents and trashed=false and appProperties has { key='type' and value='snapshot' }`, 'files(id,name,modifiedTime,appProperties),nextPageToken');
    const seenVersions = await ChatDB.getSetting('remoteSnapshotVersions', {});
    const [localRooms, localMessages] = await Promise.all([ChatDB.getAll('rooms'), ChatDB.getAll('messages')]);
    const rooms = new Map(localRooms.map(item => [item.id, item]));
    const messages = new Map(localMessages.map(item => [item.id, item]));
    let changed = false;

    for (const file of files) {
      if (file.appProperties?.deviceId === deviceId) continue;
      if (seenVersions[file.id] === file.modifiedTime) continue;
      try {
        const response = await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}?alt=media`);
        const snapshot = await response.json();
        if (snapshot.format !== 'chatnotes-device-snapshot' || snapshot.schemaVersion !== 1) continue;
        for (const remote of snapshot.rooms || []) {
          const merged = mergeEntity(rooms.get(remote.id), remote);
          if (merged !== rooms.get(remote.id)) { rooms.set(remote.id, merged); changed = true; }
        }
        for (const remote of snapshot.messages || []) {
          const merged = mergeEntity(messages.get(remote.id), remote);
          if (merged !== messages.get(remote.id)) { messages.set(remote.id, merged); changed = true; }
        }
        seenVersions[file.id] = file.modifiedTime;
      } catch (error) { console.warn('略過無法讀取的遠端快照', file.name, error); }
    }
    await ChatDB.setSetting('remoteSnapshotVersions', seenVersions);
    if (changed) {
      await Promise.all([ChatDB.putMany('rooms', [...rooms.values()]), ChatDB.putMany('messages', [...messages.values()])]);
      window.dispatchEvent(new CustomEvent('chatnotes:data-changed'));
    }
    return changed;
  }

  async function markSynced(cutoff) {
    const [rooms, messages] = await Promise.all([ChatDB.getAll('rooms'), ChatDB.getAll('messages')]);
    const eligibleRooms = rooms.filter(item => Date.parse(item.updatedAt || 0) <= cutoff && item.syncState !== 'synced').map(item => ({ ...item, syncState: 'synced' }));
    const eligibleMessages = messages.filter(item => Date.parse(item.updatedAt || 0) <= cutoff && item.syncState !== 'synced').map(item => ({ ...item, syncState: 'synced' }));
    await Promise.all([ChatDB.putMany('rooms', eligibleRooms), ChatDB.putMany('messages', eligibleMessages)]);
  }

  async function sync() {
    if (syncing) return;
    if (!state.token) throw new Error('Google Drive 尚未連接。');
    if (!navigator.onLine) throw new Error('目前沒有網路連線，資料將稍後同步。');
    syncing = true;
    const cutoff = Date.now();
    publish({ status: 'syncing', error: null });
    try {
      const folderIds = await ensureFolders();
      await uploadPendingAttachments(folderIds.attachments, cutoff);
      await writeDeviceSnapshot(folderIds.snapshots);
      const remoteChanged = await mergeRemoteSnapshots(folderIds.snapshots);
      if (remoteChanged) await writeDeviceSnapshot(folderIds.snapshots);
      await markSynced(cutoff);
      const lastSyncAt = new Date().toISOString();
      await ChatDB.setSetting('lastSyncAt', lastSyncAt);
      publish({ status: 'synced', lastSyncAt, error: null });
      window.dispatchEvent(new CustomEvent('chatnotes:data-changed'));
    } catch (error) {
      publish({ status: 'error', error: friendlyError(error) });
      throw error;
    } finally { syncing = false; }
  }

  async function downloadAttachment(attachment) {
    const cached = await ChatDB.get('blobs', attachment.id);
    if (cached?.blob) return cached.blob;
    if (!state.token) throw new Error('請先連接 Google Drive，才能下載這個附件。');
    const folderIds = await ensureFolders();
    let driveFileId = cached?.driveFileId || attachment.driveFileId;
    if (!driveFileId) {
      const files = await listFiles(`'${escapeQ(folderIds.attachments)}' in parents and trashed=false and appProperties has { key='attachmentId' and value='${escapeQ(attachment.id)}' }`, 'files(id,name,size,mimeType),nextPageToken');
      driveFileId = files[0]?.id;
    }
    if (!driveFileId) throw new Error('在 Google Drive 中找不到這個附件。');
    const response = await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`);
    const blob = await response.blob();
    await ChatDB.put('blobs', { id: attachment.id, messageId: attachment.messageId, name: attachment.name, type: attachment.type || blob.type, size: blob.size, blob, driveFileId, syncedAt: new Date().toISOString() });
    return blob;
  }

  async function getDeviceId() {
    let id = await ChatDB.getSetting('deviceId', null);
    if (!id) { id = uuid(); await ChatDB.setSetting('deviceId', id); }
    return id;
  }

  function startTimer() {
    clearInterval(timer);
    timer = setInterval(() => { if (state.token && navigator.onLine) sync().catch(() => {}); }, cfg.syncIntervalMs || 30000);
  }

  function friendlyError(error) {
    if (!navigator.onLine) return '目前沒有網路連線，資料將稍後同步。';
    const message = error?.message || String(error || '同步失敗');
    if (/storageQuotaExceeded|quota/i.test(message)) return 'Google Drive 儲存空間不足。';
    if (/insufficientFilePermissions|permission/i.test(message)) return '沒有足夠的 Google Drive 權限。';
    return message;
  }

  window.addEventListener('online', () => { if (state.token) sync().catch(() => {}); });
  window.ChatDrive = { init, authorize, revoke, sync, downloadAttachment, configured, getState: () => ({ ...state, configured: configured() }) };
})();

/* ChatNotes PWA application */
(() => {
  'use strict';
  const VERSION = '1.0.0';
  window.CHATNOTES_VERSION = VERSION;
  const $ = selector => document.querySelector(selector);
  const els = {};
  const objectUrls = new Map();
  const state = {
    rooms: [], messages: [], currentRoomId: null, pending: [], replyTo: null,
    searchScope: 'all', searchType: 'all', longPressTimer: null,
    settings: { theme: 'dark', tags: ['工作', '待辦', '參考'], meName: '我', otherName: '對方' }
  };
  const uuid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const now = () => new Date().toISOString();
  const activeRooms = () => state.rooms.filter(r => !r.deletedAt && !r.archived);
  const roomMessages = roomId => state.messages.filter(m => m.roomId === roomId && !m.deletedAt).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const currentRoom = () => state.rooms.find(r => r.id === state.currentRoomId);
  const currentMessages = () => roomMessages(state.currentRoomId);

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    cacheElements();
    bindEvents();
    await ChatDB.open();
    await loadSettings();
    await loadData();
    await ensureInitialRoom();
    restoreDraft();
    applyTheme();
    renderAll();
    registerServiceWorker();
    checkUpdate(true);
    requestPersistentStorage();
    ChatDrive.init();
  }

  function cacheElements() {
    ['app','sidebar','roomList','roomEmpty','newRoomBtn','openSearchBtn','favoritesBtn','settingsBtn','sidebarVersion',
      'chatPanel','backBtn','roomInfoBtn','roomAvatar','roomTitle','roomSubtitle','syncBtn','syncDot','syncLabel','chatSearchBtn','chatMenuBtn',
      'messageViewport','messageList','messageEmpty','jumpLatestBtn','replyBar','replyPreview','cancelReplyBtn','composer','fileInput','imageInput','attachBtn','pendingAttachments','messageInput','speakerSelect','draftStatus','sendBtn',
      'mobileChatsBtn','mobileFavoritesBtn','mobileSettingsBtn','favoriteCount','appDialog','dialogEyebrow','dialogTitle','dialogBody','dialogFooter',
      'actionSheet','sheetTitle','sheetActions','closeSheetBtn','toastRegion'].forEach(id => els[id] = document.getElementById(id));
    els.sidebarVersion.textContent = `V${VERSION}`;
  }

  function bindEvents() {
    els.newRoomBtn.addEventListener('click', () => openRoomEditor());
    els.openSearchBtn.addEventListener('click', () => openSearch());
    els.chatSearchBtn.addEventListener('click', () => openSearch(state.currentRoomId));
    els.favoritesBtn.addEventListener('click', openFavorites);
    els.settingsBtn.addEventListener('click', openSettings);
    els.mobileFavoritesBtn.addEventListener('click', openFavorites);
    els.mobileSettingsBtn.addEventListener('click', openSettings);
    els.mobileChatsBtn.addEventListener('click', () => els.app.classList.remove('chat-open'));
    els.backBtn.addEventListener('click', () => els.app.classList.remove('chat-open'));
    els.roomInfoBtn.addEventListener('click', () => openRoomEditor(currentRoom()));
    els.chatMenuBtn.addEventListener('click', openRoomMenu);
    els.syncBtn.addEventListener('click', handleSyncClick);
    els.attachBtn.addEventListener('click', openAttachSheet);
    els.closeSheetBtn.addEventListener('click', closeSheet);
    els.actionSheet.addEventListener('click', event => { if (event.target === els.actionSheet) closeSheet(); });
    els.fileInput.addEventListener('change', event => addPendingFiles(event.target.files));
    els.imageInput.addEventListener('change', event => addPendingFiles(event.target.files));
    els.composer.addEventListener('submit', sendMessage);
    els.messageInput.addEventListener('input', onComposerInput);
    els.messageInput.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); els.composer.requestSubmit(); }
    });
    els.speakerSelect.addEventListener('change', saveDraft);
    els.cancelReplyBtn.addEventListener('click', clearReply);
    els.jumpLatestBtn.addEventListener('click', () => scrollToLatest(true));
    els.messageViewport.addEventListener('scroll', handleScroll, { passive: true });
    els.appDialog.addEventListener('close', () => { els.dialogBody.replaceChildren(); els.dialogFooter.replaceChildren(); });
    window.addEventListener('chatnotes:drive-state', event => updateSyncUI(event.detail));
    window.addEventListener('chatnotes:data-changed', async () => { await loadData(false); renderAll(); });
    window.addEventListener('online', () => toast('網路已恢復，準備同步。'));
    window.addEventListener('offline', () => updateSyncUI({ status: 'local' }));
    window.addEventListener('beforeunload', revokeObjectUrls);
  }

  async function loadSettings() {
    state.settings.theme = await ChatDB.getSetting('theme', 'dark');
    state.settings.tags = await ChatDB.getSetting('tags', ['工作', '待辦', '參考']);
    state.settings.meName = await ChatDB.getSetting('meName', '我');
    state.settings.otherName = await ChatDB.getSetting('otherName', '對方');
    state.currentRoomId = await ChatDB.getSetting('currentRoomId', null);
    updateSpeakerLabels();
  }

  async function loadData(preserveRoom = true) {
    const [rooms, messages] = await Promise.all([ChatDB.getAll('rooms'), ChatDB.getAll('messages')]);
    state.rooms = rooms;
    state.messages = messages;
    if (!preserveRoom || !state.rooms.some(r => r.id === state.currentRoomId && !r.deletedAt)) {
      state.currentRoomId = activeRooms()[0]?.id || null;
    }
  }

  async function ensureInitialRoom() {
    if (activeRooms().length) {
      if (!state.currentRoomId) state.currentRoomId = activeRooms()[0].id;
      return;
    }
    const createdAt = now();
    const room = { id: uuid(), name: '隨手記', color: '#46d78b', pinned: true, archived: false, createdAt, updatedAt: createdAt, revision: 1, deviceId: await getDeviceId(), syncState: 'pending' };
    await ChatDB.put('rooms', room);
    state.rooms.push(room);
    state.currentRoomId = room.id;
    await ChatDB.setSetting('currentRoomId', room.id);
  }

  async function getDeviceId() {
    let id = await ChatDB.getSetting('deviceId', null);
    if (!id) { id = uuid(); await ChatDB.setSetting('deviceId', id); }
    return id;
  }

  function renderAll() {
    renderRooms();
    renderMessages();
    renderHeader();
    renderPending();
    updateFavoriteCount();
    updateSendState();
    updateSyncUI(ChatDrive.getState());
  }

  function renderRooms() {
    const rooms = activeRooms().sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    els.roomList.replaceChildren();
    els.roomEmpty.hidden = rooms.length > 0;
    els.roomList.hidden = rooms.length === 0;
    for (const room of rooms) {
      const messages = roomMessages(room.id);
      const latest = messages.at(-1);
      const button = el('button', `room-item${room.id === state.currentRoomId ? ' active' : ''}`);
      button.type = 'button';
      button.dataset.roomId = room.id;
      const avatar = el('span', 'room-avatar', firstCharacter(room.name));
      avatar.style.setProperty('--avatar', room.color || '#46d78b');
      const copy = el('span', 'room-copy');
      const line = el('span', 'room-name-line');
      line.append(el('span', 'room-name', room.name));
      if (room.pinned) line.append(el('span', 'pin', '◆'));
      copy.append(line, el('span', 'room-preview', latest ? previewText(latest) : '尚無記錄'));
      button.append(avatar, copy, el('span', 'room-time', latest ? compactTime(latest.createdAt) : ''));
      button.addEventListener('click', () => selectRoom(room.id));
      els.roomList.append(button);
    }
  }

  function renderHeader() {
    const room = currentRoom();
    if (!room) return;
    els.roomTitle.textContent = room.name;
    els.roomAvatar.textContent = firstCharacter(room.name);
    els.roomAvatar.style.setProperty('--avatar', room.color || '#46d78b');
    const messages = currentMessages();
    const attachmentCount = messages.reduce((sum, item) => sum + (item.attachments?.length || 0), 0);
    els.roomSubtitle.textContent = `${messages.length} 則記錄${attachmentCount ? ` · ${attachmentCount} 個附件` : ''}`;
  }

  function renderMessages({ keepPosition = false } = {}) {
    const viewport = els.messageViewport;
    const oldBottom = viewport.scrollHeight - viewport.scrollTop;
    revokeObjectUrls();
    els.messageList.replaceChildren();
    const messages = currentMessages();
    els.messageEmpty.hidden = messages.length > 0;
    let lastDate = '';
    for (const message of messages) {
      const date = localDateKey(message.createdAt);
      if (date !== lastDate) {
        const divider = el('div', 'date-divider');
        divider.append(el('span', '', friendlyDate(message.createdAt)));
        els.messageList.append(divider);
        lastDate = date;
      }
      els.messageList.append(buildMessage(message));
    }
    requestAnimationFrame(() => {
      if (keepPosition) viewport.scrollTop = viewport.scrollHeight - oldBottom;
      else scrollToLatest(false);
    });
  }

  function buildMessage(message) {
    const speaker = message.speaker || 'me';
    const row = el('article', `message-row ${speaker}`);
    row.id = `message-${message.id}`;
    row.dataset.messageId = message.id;
    const bubble = el('div', 'message-bubble');
    const speakerName = speaker === 'me' ? state.settings.meName : speaker === 'other' ? state.settings.otherName : '筆記';
    bubble.append(el('span', 'speaker-name', speakerName));
    if (message.replyTo) {
      const quoted = state.messages.find(item => item.id === message.replyTo);
      const quote = el('button', 'reply-quote', quoted ? previewText(quoted) : '原訊息已刪除');
      quote.type = 'button';
      quote.addEventListener('click', () => jumpToMessage(message.replyTo));
      bubble.append(quote);
    }
    if (message.attachments?.length) bubble.append(buildAttachments(message));
    if (message.text) bubble.append(linkify(message.text));
    if (message.tags?.length) {
      const tags = el('div', 'message-tags');
      message.tags.forEach(tag => tags.append(el('span', 'message-tag', `#${tag}`)));
      bubble.append(tags);
    }
    const meta = el('div', 'message-meta');
    if (message.favorite) meta.append(el('span', 'favorite-star', '★'));
    if (message.conflicts?.length) meta.append(el('span', 'conflict-mark', '有衝突版本'));
    if (message.revision > 1) meta.append(el('span', '', '已編輯'));
    meta.append(el('time', '', shortTime(message.createdAt)));
    meta.append(el('span', 'sync-mark', message.syncState === 'synced' ? '✓✓' : '✓'));
    bubble.append(meta);
    const menu = el('button', 'icon-btn message-menu', '•••');
    menu.type = 'button'; menu.setAttribute('aria-label', '訊息選單');
    menu.addEventListener('click', () => openMessageMenu(message));
    row.append(speaker === 'me' ? menu : bubble, speaker === 'me' ? bubble : menu);
    const start = () => { state.longPressTimer = setTimeout(() => openMessageMenu(message), 520); };
    const cancel = () => clearTimeout(state.longPressTimer);
    bubble.addEventListener('pointerdown', start); bubble.addEventListener('pointerup', cancel); bubble.addEventListener('pointercancel', cancel); bubble.addEventListener('pointermove', cancel);
    return row;
  }

  function buildAttachments(message) {
    const wrap = el('div', `attachment-grid${message.attachments.length === 1 ? ' single' : ''}`);
    for (const attachment of message.attachments) {
      if (attachment.type?.startsWith('image/')) {
        const button = el('button', 'image-attachment'); button.type = 'button';
        const placeholder = el('span', 'image-placeholder', '載入圖片…'); button.append(placeholder);
        loadImagePreview(button, attachment).catch(() => { placeholder.textContent = ChatDrive.getState().token ? '圖片無法載入' : '連接 Drive 後載入'; });
        button.addEventListener('click', () => openAttachment(attachment));
        wrap.append(button);
      } else {
        const button = el('button', 'file-attachment'); button.type = 'button';
        const icon = el('span', 'file-icon', extension(attachment.name).slice(0, 4).toUpperCase() || 'FILE');
        const copy = el('span', 'file-copy'); copy.append(el('strong', '', attachment.name), el('small', '', formatBytes(attachment.size)));
        button.append(icon, copy, svgIcon('download'));
        button.addEventListener('click', () => openAttachment(attachment));
        wrap.append(button);
      }
    }
    return wrap;
  }

  async function loadImagePreview(button, attachment) {
    const record = await ChatDB.get('blobs', attachment.id);
    if (!record?.blob) return;
    const url = URL.createObjectURL(record.blob); objectUrls.set(`${attachment.id}-thumb`, url);
    const img = new Image(); img.alt = attachment.name || '圖片'; img.src = url;
    await img.decode().catch(() => {}); button.replaceChildren(img);
  }

  async function openAttachment(attachment) {
    try {
      toast('正在準備附件…');
      const blob = await ChatDrive.downloadAttachment(attachment);
      const url = URL.createObjectURL(blob);
      if (attachment.type?.startsWith('image/')) {
        openDialog({ eyebrow: '圖片', title: attachment.name || '圖片', body: node('div', 'viewer', node('img', '', '', { src: url, alt: attachment.name || '圖片' })), buttons: [
          { label: '下載原檔', className: 'primary-btn', action: () => { downloadBlob(blob, attachment.name); closeDialog(); } }
        ], onClose: () => URL.revokeObjectURL(url) });
      } else { downloadBlob(blob, attachment.name); URL.revokeObjectURL(url); }
    } catch (error) { toast(error.message, 'error'); }
  }

  function linkify(text) {
    const p = el('p', 'message-text');
    const regex = /(https?:\/\/[^\s]+)/g;
    let last = 0;
    for (const match of text.matchAll(regex)) {
      p.append(document.createTextNode(text.slice(last, match.index)));
      const a = el('a', '', match[0]); a.href = match[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
      p.append(a); last = match.index + match[0].length;
    }
    p.append(document.createTextNode(text.slice(last)));
    return p;
  }

  async function selectRoom(roomId) {
    if (state.currentRoomId === roomId && matchMedia('(max-width:760px)').matches) { els.app.classList.add('chat-open'); return; }
    saveDraft();
    state.currentRoomId = roomId;
    await ChatDB.setSetting('currentRoomId', roomId);
    clearReply(); state.pending = [];
    restoreDraft(); renderAll();
    if (matchMedia('(max-width:760px)').matches) els.app.classList.add('chat-open');
  }

  function onComposerInput() { autoGrow(); saveDraft(); updateSendState(); }
  function autoGrow() { els.messageInput.style.height = 'auto'; els.messageInput.style.height = `${Math.min(160, els.messageInput.scrollHeight)}px`; }
  function updateSendState() { els.sendBtn.disabled = !els.messageInput.value.trim() && state.pending.length === 0; }
  async function saveDraft() {
    if (!state.currentRoomId) return;
    await ChatDB.put('drafts', { roomId: state.currentRoomId, text: els.messageInput.value, speaker: els.speakerSelect.value, replyTo: state.replyTo, savedAt: now() });
    els.draftStatus.textContent = '草稿已保存';
  }
  async function restoreDraft() {
    if (!state.currentRoomId) return;
    const draft = await ChatDB.get('drafts', state.currentRoomId);
    els.messageInput.value = draft?.text || '';
    els.speakerSelect.value = draft?.speaker || 'me';
    state.replyTo = draft?.replyTo || null;
    renderReply(); autoGrow(); updateSendState();
  }

  function openAttachSheet() {
    els.sheetTitle.textContent = '加入內容'; els.sheetActions.replaceChildren();
    const image = sheetAction('image', '圖片或拍照', () => { closeSheet(); els.imageInput.click(); });
    const file = sheetAction('file', '選擇檔案', () => { closeSheet(); els.fileInput.click(); });
    const paste = sheetAction('paste', '貼上剪貼簿', async () => {
      closeSheet();
      try { const text = await navigator.clipboard.readText(); els.messageInput.value += text; onComposerInput(); els.messageInput.focus(); }
      catch (_) { toast('瀏覽器未允許讀取剪貼簿。', 'warning'); }
    });
    els.sheetActions.append(image, file, paste); els.actionSheet.hidden = false;
  }
  function closeSheet() { els.actionSheet.hidden = true; }
  function sheetAction(icon, label, action) { const b = el('button', 'sheet-action'); b.type = 'button'; b.append(svgIcon(icon), el('span','',label)); b.addEventListener('click', action); return b; }

  async function addPendingFiles(fileList) {
    const max = window.CHATNOTES_CONFIG.maxAttachmentBytes || 104857600;
    for (const file of [...fileList]) {
      if (file.size > max) { toast(`${file.name} 超過 ${formatBytes(max)} 限制。`, 'error'); continue; }
      state.pending.push({ id: uuid(), file, url: file.type.startsWith('image/') ? URL.createObjectURL(file) : null });
    }
    els.fileInput.value = ''; els.imageInput.value = ''; renderPending(); updateSendState(); saveDraft();
  }
  function renderPending() {
    els.pendingAttachments.replaceChildren(); els.pendingAttachments.hidden = state.pending.length === 0;
    state.pending.forEach(item => {
      const wrap = el('div', 'pending-item');
      if (item.url) { const img = el('img'); img.src = item.url; img.alt = item.file.name; wrap.append(img); }
      else { const copy = el('div', 'pending-file'); copy.append(el('strong','',item.file.name), el('small','',formatBytes(item.file.size))); wrap.append(copy); }
      const remove = el('button','remove-pending','×'); remove.type='button'; remove.setAttribute('aria-label',`移除 ${item.file.name}`);
      remove.addEventListener('click', () => { if (item.url) URL.revokeObjectURL(item.url); state.pending = state.pending.filter(x => x.id !== item.id); renderPending(); updateSendState(); });
      wrap.append(remove); els.pendingAttachments.append(wrap);
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = els.messageInput.value.trim();
    if (!text && !state.pending.length) return;
    const createdAt = now(); const id = uuid(); const deviceId = await getDeviceId();
    const attachments = state.pending.map(item => ({ id: item.id, messageId: id, name: item.file.name, type: item.file.type || 'application/octet-stream', size: item.file.size }));
    const message = { id, roomId: state.currentRoomId, text, speaker: els.speakerSelect.value, attachments, replyTo: state.replyTo, tags: [], favorite: false, createdAt, updatedAt: createdAt, revision: 1, deviceId, syncState: 'pending' };
    try {
      await ChatDB.transaction(['messages','blobs','rooms','drafts'], 'readwrite', stores => {
        stores.messages.put(message);
        state.pending.forEach(item => stores.blobs.put({ id:item.id, messageId:id, name:item.file.name, type:item.file.type || 'application/octet-stream', size:item.file.size, blob:item.file }));
        const room = currentRoom(); stores.rooms.put({ ...room, updatedAt: createdAt, revision: (room.revision || 1) + 1, syncState: 'pending' });
        stores.drafts.put({ roomId: state.currentRoomId, text:'', speaker:els.speakerSelect.value, replyTo:null, savedAt:createdAt });
      });
      state.pending.forEach(item => item.url && URL.revokeObjectURL(item.url));
      state.pending = []; state.replyTo = null; els.messageInput.value = ''; autoGrow();
      await loadData(); renderAll();
      if (ChatDrive.getState().token) ChatDrive.sync().catch(() => {});
    } catch (error) { toast(`儲存失敗：${error.message}`, 'error'); }
  }

  function openMessageMenu(message) {
    els.sheetTitle.textContent = '訊息操作'; els.sheetActions.replaceChildren();
    els.sheetActions.append(
      sheetAction('reply','回覆', () => { closeSheet(); setReply(message); }),
      sheetAction('edit','編輯', () => { closeSheet(); openMessageEditor(message); }),
      sheetAction('star', message.favorite ? '取消收藏' : '收藏', () => { closeSheet(); toggleFavorite(message); }),
      sheetAction('tag','標籤', () => { closeSheet(); openTagEditor(message); }),
      sheetAction('copy','複製', async () => { closeSheet(); await navigator.clipboard.writeText(message.text || previewText(message)); toast('已複製。'); }),
      sheetAction('trash','刪除', () => { closeSheet(); confirmDeleteMessage(message); })
    );
    if(message.conflicts?.length) els.sheetActions.append(sheetAction('archive','衝突版本',()=>{closeSheet();openConflictViewer(message);}));
    els.actionSheet.hidden = false;
  }

  function openConflictViewer(message){const body=el('div');body.append(el('p','',`偵測到 ${message.conflicts.length} 個同時編輯版本。選擇要恢復的內容；目前版本會保留在編輯歷程中。`));message.conflicts.forEach((conflict,index)=>{const card=settingsCard(`版本 ${index+1}`,`${conflict.sourceDevice==='unknown'?'其他裝置':conflict.sourceDevice.slice(0,8)} · ${formatDateTime(conflict.updatedAt)}`,[el('p','',conflict.text||'(無文字)'),button('恢復此版本','secondary-btn',async()=>{const remaining=message.conflicts.filter((_,i)=>i!==index);await saveMessage({...message,text:conflict.text||'',speaker:conflict.speaker||message.speaker,conflicts:remaining});closeDialog();toast('已恢復選取的版本。');})]);body.append(card);});openDialog({eyebrow:'同步衝突',title:'保留的訊息版本',body,buttons:[{label:'完成',className:'primary-btn',close:true}]});}

  function setReply(message) { state.replyTo = message.id; renderReply(); saveDraft(); els.messageInput.focus(); }
  function clearReply() { state.replyTo = null; renderReply(); saveDraft(); }
  function renderReply() {
    const message = state.messages.find(m => m.id === state.replyTo);
    els.replyBar.hidden = !message;
    els.replyPreview.textContent = message ? previewText(message) : '';
  }

  function openMessageEditor(message) {
    const body = document.createDocumentFragment();
    const textField = field('訊息內容', 'textarea', message.text || '', { id:'editMessageText', maxlength:'20000' });
    const speakerField = field('說話者', 'select', message.speaker || 'me', { id:'editMessageSpeaker', options:[['me',state.settings.meName],['other',state.settings.otherName],['note','筆記']] });
    body.append(textField, speakerField);
    openDialog({ eyebrow:'訊息', title:'編輯訊息', body, buttons:[
      {label:'取消',className:'secondary-btn',close:true},
      {label:'儲存',className:'primary-btn',action:async()=>{
        const text=$('#editMessageText').value.trim(); if(!text && !message.attachments?.length){toast('請輸入訊息內容。','warning');return;}
        await saveMessage({ ...message, text, speaker:$('#editMessageSpeaker').value }); closeDialog();
      }}
    ]});
  }

  async function saveMessage(message) {
    message.updatedAt=now(); message.revision=(message.revision||1)+1; message.deviceId=await getDeviceId(); message.syncState='pending';
    await ChatDB.put('messages',message); await loadData(); renderAll();
    if(ChatDrive.getState().token) ChatDrive.sync().catch(()=>{});
  }
  async function toggleFavorite(message){await saveMessage({...message,favorite:!message.favorite});toast(message.favorite?'已取消收藏。':'已加入收藏。');}

  function openTagEditor(message) {
    const body=el('div');
    const list=el('div','tag-list');
    for(const tag of state.settings.tags){const label=el('label','tag-option');const input=el('input');input.type='checkbox';input.value=tag;input.checked=(message.tags||[]).includes(tag);label.append(input,document.createTextNode(tag));list.append(label);}
    body.append(list,field('新增標籤','input','',{id:'newTagInput',placeholder:'輸入新標籤'}));
    openDialog({eyebrow:'整理',title:'訊息標籤',body,buttons:[{label:'取消',className:'secondary-btn',close:true},{label:'儲存',className:'primary-btn',action:async()=>{
      const checked=[...els.dialogBody.querySelectorAll('.tag-option input:checked')].map(i=>i.value);const added=$('#newTagInput').value.trim().replace(/^#/,'');
      if(added&&!state.settings.tags.includes(added)){state.settings.tags.push(added);await ChatDB.setSetting('tags',state.settings.tags);checked.push(added);}
      await saveMessage({...message,tags:[...new Set(checked)]});closeDialog();
    }}]});
  }

  function confirmDeleteMessage(message){openConfirm('刪除訊息','這則訊息與裝置上的附件會移入回收狀態，並同步至其他裝置。','刪除',async()=>{await saveMessage({...message,deletedAt:now()});closeDialog();});}

  function openRoomEditor(room=null){
    const colors=['#46d78b','#61b8ff','#ffbc5b','#eb74c3','#a68cff','#7bd7d0'];
    const body=el('div');body.append(field('聊天室名稱','input',room?.name||'',{id:'roomName',maxlength:'60',placeholder:'例如：工作資料'}));
    const colorField=field('識別顏色','select',room?.color||colors[0],{id:'roomColor',options:colors.map(c=>[c,c])});body.append(colorField);
    const pin=el('label','check-line');const pinInput=el('input');pinInput.type='checkbox';pinInput.id='roomPinned';pinInput.checked=room?.pinned||false;pin.append(pinInput,document.createTextNode('置頂聊天室'));body.append(pin);
    openDialog({eyebrow:'聊天室',title:room?'編輯聊天室':'新增聊天室',body,buttons:[{label:'取消',className:'secondary-btn',close:true},{label:room?'儲存':'建立',className:'primary-btn',action:async()=>{
      const name=$('#roomName').value.trim();if(!name){toast('請輸入聊天室名稱。','warning');return;}
      const stamp=now(),deviceId=await getDeviceId();const value=room?{...room,name,color:$('#roomColor').value,pinned:$('#roomPinned').checked,updatedAt:stamp,revision:(room.revision||1)+1,deviceId,syncState:'pending'}:{id:uuid(),name,color:$('#roomColor').value,pinned:$('#roomPinned').checked,archived:false,createdAt:stamp,updatedAt:stamp,revision:1,deviceId,syncState:'pending'};
      await ChatDB.put('rooms',value);state.currentRoomId=value.id;await ChatDB.setSetting('currentRoomId',value.id);await loadData();renderAll();closeDialog();
    }}]});
  }

  function openRoomMenu(){const room=currentRoom();if(!room)return;els.sheetTitle.textContent=room.name;els.sheetActions.replaceChildren();els.sheetActions.append(
    sheetAction('edit','編輯',()=>{closeSheet();openRoomEditor(room)}),
    sheetAction('pin',room.pinned?'取消置頂':'置頂',async()=>{closeSheet();await saveRoom({...room,pinned:!room.pinned})}),
    sheetAction('archive','封存',async()=>{closeSheet();await saveRoom({...room,archived:true});await loadData(false);await ensureInitialRoom();await ChatDB.setSetting('currentRoomId',state.currentRoomId);await loadData();renderAll();els.app.classList.remove('chat-open')}),
    sheetAction('search','搜尋',()=>{closeSheet();openSearch(room.id)}),
    sheetAction('export','匯出備份',()=>{closeSheet();exportBackup()}),
    sheetAction('trash','刪除',()=>{closeSheet();confirmDeleteRoom(room)})
  );els.actionSheet.hidden=false;}
  async function saveRoom(room){room.updatedAt=now();room.revision=(room.revision||1)+1;room.deviceId=await getDeviceId();room.syncState='pending';await ChatDB.put('rooms',room);await loadData();renderAll();}
  function confirmDeleteRoom(room){openConfirm('刪除聊天室',`「${room.name}」及其中所有訊息會移入回收狀態。`,'刪除',async()=>{const stamp=now(),deviceId=await getDeviceId();await ChatDB.transaction(['rooms','messages'],'readwrite',stores=>{stores.rooms.put({...room,deletedAt:stamp,updatedAt:stamp,revision:(room.revision||1)+1,deviceId,syncState:'pending'});roomMessages(room.id).forEach(m=>stores.messages.put({...m,deletedAt:stamp,deletedByRoom:true,updatedAt:stamp,revision:(m.revision||1)+1,deviceId,syncState:'pending'}));});await loadData(false);await ensureInitialRoom();renderAll();closeDialog();els.app.classList.remove('chat-open');});}

  function openSearch(roomId=null,favoritesOnly=false){
    const body=el('div');const controls=el('div','search-controls');const input=el('input','search-input');input.type='search';input.id='searchQuery';input.placeholder='輸入關鍵字';input.autocomplete='off';
    const filters=el('div','filter-row');[['all','全部'],['text','文字'],['image','圖片'],['file','檔案']].forEach(([value,label])=>{const b=el('button',`filter-chip${value==='all'?' active':''}`,label);b.type='button';b.dataset.filter=value;b.addEventListener('click',()=>{filters.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));state.searchType=value;renderSearchResults(input.value,roomId,favoritesOnly,resultBox);});filters.append(b);});
    controls.append(input,filters);const resultBox=el('div','search-results');body.append(controls,resultBox);
    input.addEventListener('input',()=>renderSearchResults(input.value,roomId,favoritesOnly,resultBox));
    openDialog({eyebrow:favoritesOnly?'收藏':'搜尋',title:favoritesOnly?'收藏的訊息':roomId?'搜尋目前聊天室':'搜尋所有記錄',body,buttons:[]});
    renderSearchResults('',roomId,favoritesOnly,resultBox);setTimeout(()=>input.focus(),100);
  }
  function openFavorites(){openSearch(null,true);}
  function renderSearchResults(query,roomId,favoritesOnly,box){
    const q=query.trim().toLocaleLowerCase();let messages=state.messages.filter(m=>!m.deletedAt&&(!roomId||m.roomId===roomId)&&(!favoritesOnly||m.favorite));
    if(state.searchType==='text')messages=messages.filter(m=>m.text);if(state.searchType==='image')messages=messages.filter(m=>m.attachments?.some(a=>a.type?.startsWith('image/')));if(state.searchType==='file')messages=messages.filter(m=>m.attachments?.some(a=>!a.type?.startsWith('image/')));
    if(q)messages=messages.filter(m=>[m.text,(m.tags||[]).join(' '),(m.attachments||[]).map(a=>a.name).join(' '),m.speaker==='me'?state.settings.meName:state.settings.otherName].join(' ').toLocaleLowerCase().includes(q));
    messages.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));box.replaceChildren();
    if(!messages.length){box.append(el('div','result-empty',q?'找不到符合的記錄':'目前沒有內容'));return;}
    for(const m of messages.slice(0,200)){const room=state.rooms.find(r=>r.id===m.roomId);const b=el('button','search-result');b.type='button';const head=el('span','search-result-head');head.append(el('span','',room?.name||'已刪除聊天室'),el('span','',formatDateTime(m.createdAt)));b.append(head,el('p','',previewText(m)));b.addEventListener('click',()=>{closeDialog();selectRoom(m.roomId).then(()=>setTimeout(()=>jumpToMessage(m.id),120));});box.append(b);}
  }

  async function openSettings(){
    const estimate=await navigator.storage?.estimate?.().catch(()=>null);const lastSync=await ChatDB.getSetting('lastSyncAt',null);const drive=ChatDrive.getState();
    const body=el('div');
    body.append(settingsCard('Google Drive','連接後會同步聊天室、訊息與附件。',[
      statusRow('狀態',drive.token?(drive.user?.email||'已連接'):(drive.configured?'尚未連接':'尚未設定 Client ID')),
      buttonRow(drive.token?[button('立即同步','primary-btn',async()=>{await handleSyncClick();closeDialog(); }),button('中斷連接','secondary-btn',async()=>{await ChatDrive.revoke();closeDialog();toast('已中斷 Google Drive 連接。')})]:[button('連接 Google Drive','primary-btn',async()=>{try{await ChatDrive.authorize(true);closeDialog()}catch(e){toast(e.message,'error')}})])
    ]));
    const appearance=el('div');appearance.append(field('顯示主題','select',state.settings.theme,{id:'themeSetting',options:[['dark','深色'],['light','淺色'],['system','跟隨系統']]}),field('自己的名稱','input',state.settings.meName,{id:'meNameSetting',maxlength:'30'}),field('對方名稱','input',state.settings.otherName,{id:'otherNameSetting',maxlength:'30'}),field('常用標籤（以逗號分隔）','input',state.settings.tags.join(', '),{id:'tagsSetting'}),button('儲存顯示設定','primary-btn',saveAppearanceSettings));body.append(settingsCard('顯示與名稱','套用至所有聊天室的訊息氣泡。',[appearance]));
    body.append(settingsCard('版本更新','程式開啟時會自動檢查並套用可用更新。',[
      statusRow('目前版本',`V${VERSION}`),statusRow('最新版本',await ChatDB.getSetting('latestVersion','尚未檢查')),
      buttonRow([button('檢查更新','secondary-btn',async()=>{await checkUpdate(false);closeDialog();})])
    ]));
    const usage=estimate?`${formatBytes(estimate.usage||0)} / ${formatBytes(estimate.quota||0)}`:'瀏覽器未提供';const ratio=estimate?.quota?Math.min(100,(estimate.usage/estimate.quota)*100):0;
    const meter=el('div','storage-meter');const fill=el('span');fill.style.width=`${ratio}%`;meter.append(fill);
    body.append(settingsCard('資料與備份','備份包含聊天室、訊息與這台裝置已下載的附件。',[
      statusRow('本機用量',usage),meter,statusRow('上次同步',lastSync?formatDateTime(lastSync):'尚未同步'),
      buttonRow([button('匯出 ZIP 備份','primary-btn',exportBackup),button('還原 ZIP 備份','secondary-btn',()=>{closeDialog();chooseRestore();})])
    ]));
    const managedRooms=state.rooms.filter(r=>r.archived||r.deletedAt);if(managedRooms.length){const items=el('div');managedRooms.forEach(room=>{const row=el('div','status-row');row.append(el('span','',`${room.deletedAt?'已刪除':'已封存'} · ${room.name}`),button('恢復','secondary-btn',async()=>{await restoreRoom(room);closeDialog();toast(`已恢復「${room.name}」。`);}));items.append(row);});body.append(settingsCard('封存與回收','可恢復封存或誤刪的聊天室。',[items]));}
    const danger=settingsCard('本機資料','清除前請先確認資料已同步或匯出備份。',[buttonRow([button('清除本機資料','danger-btn',()=>{closeDialog();confirmClearLocal();})])]);danger.classList.add('danger-zone');body.append(danger);
    openDialog({eyebrow:'設定',title:'聊記設定',body,buttons:[{label:'完成',className:'primary-btn',close:true}]});
  }

  async function restoreRoom(room){const stamp=now(),deviceId=await getDeviceId(),restored={...room,archived:false,updatedAt:stamp,revision:(room.revision||1)+1,deviceId,syncState:'pending'};delete restored.deletedAt;await ChatDB.transaction(['rooms','messages'],'readwrite',stores=>{stores.rooms.put(restored);state.messages.filter(m=>m.roomId===room.id&&m.deletedByRoom).forEach(m=>{const copy={...m,updatedAt:stamp,revision:(m.revision||1)+1,deviceId,syncState:'pending'};delete copy.deletedAt;delete copy.deletedByRoom;stores.messages.put(copy);});});state.currentRoomId=room.id;await ChatDB.setSetting('currentRoomId',room.id);await loadData();renderAll();}

  async function saveAppearanceSettings(){state.settings.theme=$('#themeSetting').value;state.settings.meName=$('#meNameSetting').value.trim()||'我';state.settings.otherName=$('#otherNameSetting').value.trim()||'對方';state.settings.tags=$('#tagsSetting').value.split(/[,，]/).map(x=>x.trim().replace(/^#/,'')).filter(Boolean).slice(0,50);await Promise.all([ChatDB.setSetting('theme',state.settings.theme),ChatDB.setSetting('meName',state.settings.meName),ChatDB.setSetting('otherName',state.settings.otherName),ChatDB.setSetting('tags',state.settings.tags)]);updateSpeakerLabels();applyTheme();renderAll();toast('顯示設定已儲存。');}
  function updateSpeakerLabels(){const me=els.speakerSelect?.querySelector('[value="me"]'),other=els.speakerSelect?.querySelector('[value="other"]');if(me)me.textContent=state.settings.meName;if(other)other.textContent=state.settings.otherName;}
  function applyTheme(){let theme=state.settings.theme;if(theme==='system')theme=matchMedia('(prefers-color-scheme:light)').matches?'light':'dark';document.documentElement.dataset.theme=theme;document.querySelector('meta[name="theme-color"]').content=theme==='light'?'#f9fbfa':'#0b1411';}

  async function exportBackup(){
    try{toast('正在建立備份…');const snapshot=await ChatDB.exportSnapshot();const blobs=await ChatDB.getAll('blobs');const files=[];const included=[];for(const record of blobs){if(!record.blob)continue;const archiveName=`attachments/${record.id}__${safeName(record.name||'file')}`;files.push({name:archiveName,data:record.blob});included.push({id:record.id,messageId:record.messageId,name:record.name,type:record.type,size:record.size,archiveName,driveFileId:record.driveFileId||null});}snapshot.attachments=included;snapshot.missingAttachments=state.messages.flatMap(m=>m.attachments||[]).filter(a=>!included.some(i=>i.id===a.id)).map(a=>({id:a.id,name:a.name,messageId:a.messageId}));files.unshift({name:'backup.json',data:JSON.stringify(snapshot,null,2)});const zip=await ChatZip.create(files);downloadBlob(zip,`ChatNotes-backup-${fileStamp()}.zip`);toast(`備份完成，共 ${snapshot.messages.length} 則記錄。`);}catch(error){toast(`備份失敗：${error.message}`,'error');}
  }
  function chooseRestore(){const input=el('input');input.type='file';input.accept='.zip,application/zip';input.addEventListener('change',()=>{if(input.files[0])prepareRestore(input.files[0])});input.click();}
  async function prepareRestore(file){
    try{toast('正在檢查備份…');const files=await ChatZip.read(file);const backupBytes=files.get('backup.json');if(!backupBytes)throw new Error('ZIP 中缺少 backup.json。');const snapshot=JSON.parse(ChatZip.text(backupBytes));if(snapshot.format!=='chatnotes-snapshot'||snapshot.schemaVersion!==1)throw new Error('備份格式不相容。');
      const body=el('div');body.append(settingsCard('備份內容','還原前會先下載目前資料的保護備份。',[statusRow('聊天室',String(snapshot.rooms?.length||0)),statusRow('訊息',String(snapshot.messages?.length||0)),statusRow('附件',String(snapshot.attachments?.length||0)),statusRow('建立時間',formatDateTime(snapshot.exportedAt))]));
      const mode=field('還原方式','select','merge',{id:'restoreMode',options:[['merge','合併現有資料'],['replace','清除本機後還原']]});body.append(mode);
      openDialog({eyebrow:'還原',title:'確認備份內容',body,buttons:[{label:'取消',className:'secondary-btn',close:true},{label:'開始還原',className:'primary-btn',action:async()=>{await exportBackup();const replace=$('#restoreMode').value==='replace';await ChatDB.importSnapshot(snapshot,{replace});if(replace)await ChatDB.clear('blobs');for(const meta of snapshot.attachments||[]){const data=files.get(meta.archiveName);if(data)await ChatDB.put('blobs',{...meta,blob:new Blob([data],{type:meta.type||'application/octet-stream'})});}await loadSettings();await loadData(false);await ensureInitialRoom();renderAll();closeDialog();toast('備份已還原。');}}]});
    }catch(error){toast(`無法還原：${error.message}`,'error');}
  }
  function confirmClearLocal(){openConfirm('清除本機資料','這會移除這台裝置上的聊天室、訊息、草稿與附件。Google Drive 中的既有檔案不會被刪除。','清除',async()=>{await Promise.all(['rooms','messages','blobs','drafts'].map(s=>ChatDB.clear(s)));await ChatDB.setSetting('currentRoomId',null);state.rooms=[];state.messages=[];state.currentRoomId=null;await ensureInitialRoom();renderAll();closeDialog();toast('本機資料已清除。');});}

  async function handleSyncClick(){const drive=ChatDrive.getState();try{if(!drive.configured)throw new Error('請先在 config.js 設定 Google OAuth Client ID。');if(!drive.token){await ChatDrive.authorize(true);return;}await ChatDrive.sync();toast('Google Drive 同步完成。');}catch(error){toast(error.message,'error');}}
  function updateSyncUI(detail={}){let label='僅存本機',kind='local';if(!navigator.onLine){label='離線';kind='local';}else if(detail.status==='syncing'){label='同步中';kind='syncing';}else if(detail.status==='synced'){label='已同步';kind='synced';}else if(detail.status==='error'){label='需處理';kind='error';}els.syncDot.className=`sync-dot ${kind}`;els.syncLabel.textContent=label;els.syncBtn.title=detail.error||label;}

  async function checkUpdate(silent){try{const response=await fetch(`version.json?t=${Date.now()}`,{cache:'no-store'});if(!response.ok)throw new Error('無法取得版本資訊');const data=await response.json();const latest=data.version||VERSION;await ChatDB.setSetting('latestVersion',`V${latest}`);if(compareVersions(latest,VERSION)>0){toast(`發現新版 V${latest}，正在更新…`);const reg=await navigator.serviceWorker?.getRegistration();await reg?.update();if(reg?.waiting)reg.waiting.postMessage({type:'SKIP_WAITING'});else setTimeout(()=>location.reload(),800);}else if(!silent)toast('目前已是最新版本。');}catch(error){if(!silent)toast(`檢查更新失敗：${error.message}`,'error');}}
  function registerServiceWorker(){if(!('serviceWorker'in navigator))return;navigator.serviceWorker.register('sw.js').then(reg=>{reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)worker.postMessage({type:'SKIP_WAITING'});});});navigator.serviceWorker.addEventListener('controllerchange',()=>location.reload());}).catch(error=>console.warn('Service Worker',error));}
  async function requestPersistentStorage(){try{if(navigator.storage?.persist)await navigator.storage.persist();}catch(_){}}

  function openDialog({eyebrow='',title='',body,buttons=[],onClose=null}){els.dialogEyebrow.textContent=eyebrow;els.dialogTitle.textContent=title;els.dialogBody.replaceChildren(body||el('div'));els.dialogFooter.replaceChildren();for(const spec of buttons){const b=button(spec.label,spec.className||'secondary-btn',async()=>{if(spec.close){closeDialog();return;}if(spec.action)await spec.action();});els.dialogFooter.append(b);}els.dialogFooter.hidden=buttons.length===0;if(onClose)els.appDialog.addEventListener('close',onClose,{once:true});els.appDialog.showModal();}
  function closeDialog(){if(els.appDialog.open)els.appDialog.close();}
  function openConfirm(title,text,confirmLabel,action){const body=el('p','',text);body.style.lineHeight='1.65';body.style.color='var(--muted)';openDialog({eyebrow:'確認',title,body,buttons:[{label:'取消',className:'secondary-btn',close:true},{label:confirmLabel,className:'danger-btn',action}]});}

  function field(label,type,value='',attrs={}){const wrap=el('label','field');wrap.append(el('span','',label));let control;if(type==='textarea')control=el('textarea');else if(type==='select'){control=el('select');for(const [v,l]of attrs.options||[]){const option=el('option','',l);option.value=v;option.selected=v===value;control.append(option);}}else{control=el('input');control.type=type;}if(type!=='select')control.value=value;for(const [key,val]of Object.entries(attrs)){if(key==='options')continue;if(key==='id')control.id=val;else control.setAttribute(key,val);}wrap.append(control);return wrap;}
  function settingsCard(title,description,children=[]){const card=el('section','section-card');card.append(el('h3','',title));if(description)card.append(el('p','',description));children.forEach(child=>card.append(child));return card;}
  function statusRow(label,value){const row=el('div','status-row');row.append(el('span','',label),el('strong','',value));return row;}
  function buttonRow(buttons){const row=el('div','button-row');buttons.forEach(b=>row.append(b));return row;}
  function button(label,className,action){const b=el('button',className,label);b.type='button';if(action)b.addEventListener('click',action);return b;}
  function el(tag,className='',text=''){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined&&text!==null&&text!=='')node.textContent=text;return node;}
  function node(tag,className='',text='',attrs={}){const n=el(tag,className,text);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,v);return n;}
  function svgIcon(name){const paths={download:'<path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M5 20h14"/>',image:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5L5 20"/>',file:'<path d="M6 2h8l4 4v16H6Z"/><path d="M14 2v5h5"/>',paste:'<path d="M9 5h6v3H9z"/><path d="M7 6H5v16h14V6h-2"/>',reply:'<path d="m9 17-5-5 5-5"/><path d="M4 12h9a7 7 0 0 1 7 7"/>',edit:'<path d="m4 20 4.5-1 10-10-3.5-3.5-10 10Z"/><path d="m13.5 6.5 3.5 3.5"/>',star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>',tag:'<path d="M3 12V4h8l10 10-7 7Z"/><circle cx="8" cy="9" r="1"/>',copy:'<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',trash:'<path d="M4 7h16M9 7V4h6v3m3 0-1 14H7L6 7"/>',pin:'<path d="m12 17-5 4 1-7-4-4 6-1 2-6 2 6 6 1-4 4 1 7Z"/>',archive:'<path d="M4 7v14h16V7M2 3h20v4H2Z"/><path d="M9 12h6"/>',search:'<circle cx="11" cy="11" r="7"/><path d="m16 16 4 4"/>',export:'<path d="M12 16V3m0 0-4 4m4-4 4 4"/><path d="M5 14v7h14v-7"/>'};const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.innerHTML=paths[name]||paths.file;return svg;}

  function updateFavoriteCount(){els.favoriteCount.textContent=String(state.messages.filter(m=>m.favorite&&!m.deletedAt).length);}
  function handleScroll(){const v=els.messageViewport;els.jumpLatestBtn.hidden=v.scrollHeight-v.scrollTop-v.clientHeight<180;}
  function scrollToLatest(smooth){els.messageViewport.scrollTo({top:els.messageViewport.scrollHeight,behavior:smooth?'smooth':'auto'});els.jumpLatestBtn.hidden=true;}
  function jumpToMessage(id){const target=document.getElementById(`message-${id}`);if(!target){toast('原訊息不存在。','warning');return;}target.scrollIntoView({behavior:'smooth',block:'center'});const bubble=target.querySelector('.message-bubble');bubble.animate([{outline:'2px solid var(--accent)'},{outline:'2px solid transparent'}],{duration:1600});}
  function previewText(message){if(message.text)return message.text.replace(/\s+/g,' ').slice(0,100);const a=message.attachments?.[0];return a?(a.type?.startsWith('image/')?'[圖片] ':'[檔案] ')+(a.name||'附件'):'空白訊息';}
  function firstCharacter(text){return [...(text||'記')][0];}
  function localDateKey(iso){const d=new Date(iso);return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;}
  function friendlyDate(iso){const d=new Date(iso),today=new Date(),yesterday=new Date(Date.now()-86400000);const key=localDateKey(iso);if(key===localDateKey(today.toISOString()))return'今天';if(key===localDateKey(yesterday.toISOString()))return'昨天';return new Intl.DateTimeFormat('zh-TW',{year:d.getFullYear()===today.getFullYear()?undefined:'numeric',month:'short',day:'numeric',weekday:'short'}).format(d);}
  function shortTime(iso){return new Intl.DateTimeFormat('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));}
  function compactTime(iso){const d=new Date(iso),t=new Date();return localDateKey(iso)===localDateKey(t.toISOString())?shortTime(iso):`${d.getMonth()+1}/${d.getDate()}`;}
  function formatDateTime(iso){if(!iso)return'—';return new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(iso));}
  function formatBytes(bytes){if(!Number.isFinite(bytes))return'—';if(bytes<1024)return`${bytes} B`;const units=['KB','MB','GB','TB'];let n=bytes/1024,i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return`${n.toFixed(n>=10?1:2)} ${units[i]}`;}
  function extension(name=''){return name.includes('.')?name.split('.').pop():'';}
  function safeName(name){return name.replace(/[\\/:*?"<>|\x00-\x1f]/g,'_').slice(0,160)||'file';}
  function fileStamp(){const d=new Date(),p=n=>String(n).padStart(2,'0');return`${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;}
  function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=el('a');a.href=url;a.download=name||'download';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function revokeObjectUrls(){for(const url of objectUrls.values())URL.revokeObjectURL(url);objectUrls.clear();}
  function compareVersions(a,b){const pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);for(let i=0;i<Math.max(pa.length,pb.length);i++){const diff=(pa[i]||0)-(pb[i]||0);if(diff)return diff;}return 0;}
  function toast(message,type='success'){const item=el('div',`toast ${type}`,message);els.toastRegion.append(item);setTimeout(()=>item.remove(),4200);}
})();

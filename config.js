/*
 * Google Cloud 設定：只需替換 clientId。
 * OAuth 類型請選「網頁應用程式」，並加入實際 GitHub Pages 網址至已授權的 JavaScript 來源。
 */
window.CHATNOTES_CONFIG = Object.freeze({
  clientId: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com',
  appFolderName: 'ChatNotes-PWA',
  appId: 'chatnotes-pwa',
  syncIntervalMs: 30000,
  maxAttachmentBytes: 100 * 1024 * 1024
});

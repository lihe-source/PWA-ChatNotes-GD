# 聊記 ChatNotes PWA V1.0.0

聊天室式個人記事 PWA，可保存文字、圖片、一般檔案與對話，支援離線使用、搜尋、收藏、標籤、ZIP 備份，以及使用 Google Drive API 跨裝置同步。

## 功能

- 聊天室式分類：新增、編輯、置頂、封存與刪除。
- 訊息：文字、網址、說話者、引用回覆、編輯、複製、收藏、標籤與刪除。
- 附件：圖片預覽、拍照、一般檔案、大檔續傳與下載。
- 本機優先：資料先寫入 IndexedDB，沒有網路時仍可使用。
- Google Drive：每台裝置建立獨立快照並自動合併；附件獨立保存。
- 搜尋：依文字、檔名、標籤、聊天室與附件類型篩選。
- 備份：完整匯出 ZIP，並能合併或取代方式還原。
- PWA：安裝至主畫面、離線程式快取、啟動檢查更新。
- 響應式介面：手機單欄、iPad／電腦雙欄、iOS 安全區及鍵盤適配。

## 一、設定 Google Cloud

1. 前往 [Google Cloud Console](https://console.cloud.google.com/) 建立或選擇專案。
2. 在「API 和服務」→「程式庫」啟用 **Google Drive API**。
3. 在「Google Auth Platform」設定應用程式名稱、支援信箱與開發人員聯絡資料。
4. 若應用程式處於測試狀態，將實際使用的 Google 帳號加入「測試使用者」。
5. 在「用戶端」建立 **OAuth 用戶端 ID**，應用程式類型選擇「網頁應用程式」。
6. 在「已授權的 JavaScript 來源」加入 GitHub Pages 的來源，例如：

   ```text
   https://lihe-source.github.io
   ```

   來源只包含網域，不加入儲存庫路徑，結尾不要加斜線。
7. 複製 OAuth 用戶端 ID，開啟 `config.js`，替換：

   ```js
   clientId: 'YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com'
   ```

OAuth Client ID 可以放在公開前端程式中；請勿把 Client Secret、存取權杖或私人 API 金鑰放進 GitHub。

本程式使用 `drive.file` 範圍，只能存取由程式建立或使用者明確授權的 Drive 檔案。第一次連接需要使用者操作 Google 授權；之後會嘗試在開啟時恢復連接。Google 權杖到期或瀏覽器阻止授權視窗時，需按一次「重新連接」。

## 二、部署 GitHub Pages

1. 建立新的 GitHub 儲存庫，例如 `PWA-ChatNotes-GD`。
2. 將本資料夾內所有檔案上傳到儲存庫根目錄。不要再多包一層資料夾。
3. 開啟儲存庫 **Settings → Pages**。
4. Source 選擇 **Deploy from a branch**。
5. Branch 選擇 `main`，資料夾選擇 `/(root)`，按 **Save**。
6. 等待部署完成，再開啟：

   ```text
   https://你的帳號.github.io/儲存庫名稱/
   ```

7. 把實際網址的來源網域加入 Google OAuth 的「已授權的 JavaScript 來源」。

每個 GitHub Pages 網址都必須使用 HTTPS。若變更儲存庫名稱或改用自訂網域，需同步更新 OAuth 的授權來源。

## 三、首次使用

1. 開啟網站；程式會直接進入「隨手記」，未登入也能記事。
2. 到「設定」→「Google Drive」→「連接 Google Drive」。
3. 選擇 Google 帳號並允許存取。
4. 連接完成後，程式會在「我的雲端硬碟」建立 `ChatNotes-PWA` 資料夾。
5. iPhone／iPad 請用 Safari 開啟網站，再選「分享」→「加入主畫面」。

## 四、Google Drive 資料結構

```text
ChatNotes-PWA/
├─ snapshots/     每台裝置的聊天室與訊息快照
├─ attachments/   圖片與一般附件
└─ backups/       保留供後續雲端快照功能使用
```

不要手動改名、移動或編輯 `snapshots` 內的 JSON。一般 Drive 垃圾桶清理或刪除 `ChatNotes-PWA` 會移除雲端同步資料，但不會立刻刪除仍存在裝置 IndexedDB 的內容。

## 五、更新版本

每次發布新版本時，至少修改下列三處為同一版本號：

- `app.js` 的 `VERSION`
- `sw.js` 的 `APP_VERSION`
- `version.json` 的 `version`

上傳至 GitHub 後，程式在開啟時會讀取 `version.json`。發現新版會保存既有 IndexedDB 資料、更新程式快取並重新載入。

## 六、資料安全與限制

- Google Drive 是同步儲存區，建議仍定期使用「匯出 ZIP 備份」。
- ZIP 採無壓縮格式，以確保程式完全離線且不依賴外部 ZIP 套件；檔案可能比一般壓縮 ZIP 大。
- 關閉 PWA 後，純 GitHub Pages 無法持續執行 Drive 上傳；未完成項目會在下次開啟後續傳。
- 第一版為同一 Google 帳號跨裝置使用。多人即時聊天、背景推播及成員權限需要額外後端服務。
- 單一附件預設上限為 100 MB，可在 `config.js` 調整 `maxAttachmentBytes`。

## 驗收清單

- 未連接 Google 時可以建立聊天室、文字、圖片與檔案。
- 關閉並重新開啟後，本機資料及草稿仍存在。
- 連接 Drive 後顯示「已同步」，第二台裝置可取得聊天室與訊息。
- 網路中斷後新增內容顯示待同步，恢復連線後完成同步。
- ZIP 備份包含 `backup.json` 與已下載附件，還原後引用、收藏與標籤正常。
- iPhone 鍵盤開啟時輸入列貼底，不出現水平捲動或底部異常空白。

// 雲端同步（僅在 claude.ai Artifact 內可用）：把每條註記另存一份到 db 的個人私有區
// data/users/<id>/ 之下，跨裝置同步、避免瀏覽器清除資料時遺失。
// 本機 IndexedDB 仍是主要儲存；兩邊以紀錄的時間戳記 t 較新者為準（刪除以墓碑記錄）。
const MAX_BYTES = 250000;

export class Cloud {
  constructor() {
    this.col = null;
    this.ready = false;
    this.state = 'off';      // off | connecting | on | error
    this.queue = new Map();  // docId -> data
    this.timer = null;
    this.busy = false;
    this.tooBig = new Set();
    this.onState = () => {};
  }

  async init(onDoc, onFirstSync) {
    if (!(window.claude && typeof window.claude.use === 'function')) return false;
    this.setState('connecting');
    try {
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      if (!db || !user) { this.setState('off'); return false; }
      const uid = await user.id();
      if (!uid) { this.setState('off'); return false; }
      this.col = db.collection('data/users/' + uid);
    } catch (e) {
      console.warn('雲端同步無法啟用', e);
      this.setState('off');
      return false;
    }
    let first = true;
    const timeout = setTimeout(() => { if (first) this.setState('error', '暫時連不上雲端，註記先存在本機'); }, 10000);
    this.unsub = this.col.onSnapshot((snap) => {
      for (const ch of snap.docChanges()) {
        if (ch.type === 'removed') continue;
        const d = ch.doc.data();
        if (d) onDoc(ch.doc.id, JSON.parse(JSON.stringify(d)));
      }
      if (first && !snap.metadata.fromCache) {
        first = false;
        clearTimeout(timeout);
        this.ready = true;
        this.setState('on');
        onFirstSync(new Set(snap.docs.map((d) => d.id)));
        this.flushSoon();
      }
    }, (e) => {
      clearTimeout(timeout);
      console.warn('雲端同步中斷', e);
      this.ready = false;
      this.setState('error', e && e.code === 'revoked' ? '雲端同步已停用' : '雲端同步中斷，註記先存在本機');
    });
    return true;
  }

  setState(s, msg) { this.state = s; this.msg = msg || ''; this.onState(s, msg); }

  push(id, data) {
    if (!this.col) return;
    this.queue.set(id, data);
    this.flushSoon();
  }

  flushSoon(ms = 1500) {
    if (!this.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), ms);
  }

  async flush() {
    if (this.busy || !this.ready) return;
    this.busy = true;
    try {
      while (this.queue.size) {
        const [id, data] = this.queue.entries().next().value;
        this.queue.delete(id);
        const body = JSON.parse(JSON.stringify(data));
        if (JSON.stringify(body).length > MAX_BYTES) {
          if (!this.tooBig.has(id)) { this.tooBig.add(id); this.onState('warn', '本條手寫筆畫過多，雲端只保留在本機（請用匯出備份）'); }
          continue;
        }
        try {
          await this.col.doc(id).set(body);
        } catch (e) {
          const code = e && e.code;
          if (code === 'unavailable' || code === 'resource_exhausted') {
            if (!this.queue.has(id)) this.queue.set(id, data);
            this.busy = false;
            this.flushSoon(code === 'resource_exhausted' ? 15000 : 4000);
            return;
          }
          if (code === 'quota_exceeded') { this.onState('warn', '雲端空間已滿，新的註記只存在本機'); continue; }
          if (code === 'invalid_argument') { this.ready = false; this.setState('error', '此帳號無法寫入雲端，註記只存在本機'); return; }
          console.warn('雲端寫入失敗', id, e);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

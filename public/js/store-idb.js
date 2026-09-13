/* IndexedDB storage for the race index. Same interface as MemoryBackend in
   core/index.js: everything lives on this device, nothing is sent anywhere. */

const DB_NAME = 'bibscan-web';
const DB_VERSION = 1;

const done = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

const finished = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
});

export class IDBBackend {
  constructor(db) {
    this.db = db;
    // Another tab upgrading the schema must not be blocked by this one.
    db.onversionchange = () => db.close();
  }

  static open(name = DB_NAME) {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('races')) db.createObjectStore('races', { keyPath: 'event_id' });
        if (!db.objectStoreNames.contains('runners')) {
          db.createObjectStore('runners', { keyPath: ['event_id', 'course_id', 'bib'] }).createIndex('event_id', 'event_id');
        }
        if (!db.objectStoreNames.contains('sightings')) {
          db.createObjectStore('sightings', { keyPath: ['event_id', 'bib'] }).createIndex('event_id', 'event_id');
        }
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(new IDBBackend(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('the database is open in an older tab; close other bibscan tabs and reload'));
    });
  }

  store(name, mode = 'readonly') {
    const tx = this.db.transaction(name, mode);
    return [tx.objectStore(name), tx];
  }

  async get(name, key) {
    const [s] = this.store(name);
    return (await done(s.get(key))) ?? null;
  }

  async put(name, value) {
    const [s, tx] = this.store(name, 'readwrite');
    s.put(value);
    await finished(tx);
  }

  async putMany(name, values) {
    if (!values.length) return;
    const [s, tx] = this.store(name, 'readwrite');
    for (const v of values) s.put(v);
    await finished(tx);
  }

  async delete(name, key) {
    const [s, tx] = this.store(name, 'readwrite');
    s.delete(key);
    await finished(tx);
  }

  async getAll(name) {
    const [s] = this.store(name);
    return done(s.getAll());
  }

  async getAllByEvent(name, eventId) {
    const [s] = this.store(name);
    return done(s.index('event_id').getAll(IDBKeyRange.only(eventId)));
  }

  async countByEvent(name, eventId) {
    const [s] = this.store(name);
    return done(s.index('event_id').count(IDBKeyRange.only(eventId)));
  }

  async deleteByEvent(name, eventId) {
    const [s, tx] = this.store(name, 'readwrite');
    const req = s.index('event_id').openKeyCursor(IDBKeyRange.only(eventId));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return;
      s.delete(cursor.primaryKey);
      cursor.continue();
    };
    await finished(tx);
  }

  async clear() {
    const names = ['races', 'runners', 'sightings', 'meta'];
    const tx = this.db.transaction(names, 'readwrite');
    for (const n of names) tx.objectStore(n).clear();
    await finished(tx);
  }
}

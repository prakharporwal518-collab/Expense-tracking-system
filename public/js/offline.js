/**
 * Offline outbox.
 *
 * Expenses are logged in the moment — in a shop, on a phone, often with no
 * signal. A write made offline is stored in IndexedDB and replayed when the
 * connection returns. Each entry carries a client-generated id that the server
 * treats as an idempotency key, so a retry that actually succeeded the first
 * time cannot create a second expense.
 *
 * Only expense creation is queued. Everything else needs a live connection and
 * says so, rather than pretending to work.
 */
const DB_NAME = 'fintrack-offline';
const STORE = 'outbox';
const listeners = new Set();

export const newUuid = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    .replace(/[^A-Za-z0-9_-]/g, '');

function openDb() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, 1);
    } catch (err) {
      return reject(err); // private mode / storage blocked
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'uuid' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const result = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(result?.result ?? result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const notify = async () => {
  const count = await pendingCount().catch(() => 0);
  for (const fn of listeners) {
    try { fn(count); } catch { /* a bad listener must not break syncing */ }
  }
};

export const onPendingChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function queueExpense(payload) {
  const entry = { uuid: payload.clientUuid || newUuid(), payload, queuedAt: new Date().toISOString(), attempts: 0 };
  entry.payload.clientUuid = entry.uuid;
  await withStore('readwrite', (store) => store.put(entry));
  await notify();
  return entry;
}

export async function pendingCount() {
  try {
    return await withStore('readonly', (store) => store.count());
  } catch {
    return 0; // IndexedDB unavailable: treat as nothing queued rather than crashing
  }
}

export async function pendingEntries() {
  try {
    return (await withStore('readonly', (store) => store.getAll())) || [];
  } catch {
    return [];
  }
}

const remove = (uuid) => withStore('readwrite', (store) => store.delete(uuid)).catch(() => {});

let flushing = false;

/**
 * Replays queued writes oldest-first.
 * A rejection the server will never accept (4xx) is dropped and reported —
 * retrying it forever would block everything behind it. A network failure
 * leaves the entry in place for the next attempt.
 */
export async function flush(send) {
  if (flushing || !navigator.onLine) return { sent: 0, failed: 0, dropped: 0 };
  flushing = true;
  let sent = 0, failed = 0, dropped = 0;
  const problems = [];

  try {
    const entries = (await pendingEntries()).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
    for (const entry of entries) {
      try {
        await send(entry.payload);
        await remove(entry.uuid);
        sent++;
      } catch (err) {
        if (err && err.status >= 400 && err.status < 500 && err.status !== 429) {
          await remove(entry.uuid);
          dropped++;
          problems.push(err.message || 'rejected');
        } else {
          failed++;
          break; // offline again — stop and keep the rest for later
        }
      }
    }
  } finally {
    flushing = false;
    await notify();
  }
  return { sent, failed, dropped, problems };
}

// db.js: everything that talks to IndexedDB lives in this file.
// game.js calls these functions. YOU write them.
// Your packet's DATA SPEC says WHAT every record holds. Spell every name EXACTLY
// like the spec, so your teacher can open DevTools and find everything.

const DB_NAME = "questDB";
const DB_VERSION = 2;

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Database transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Database transaction aborted."));
  });
}

async function withTransaction(db, storeNames, mode, action) {
  const transaction = db.transaction(storeNames, mode);
  const done = transactionDone(transaction);
  try {
    const result = await action(transaction);
    await done;
    return result;
  } catch (error) {
    await done.catch(() => {});
    throw error;
  }
}

async function withDB(action) {
  const db = await openDB();
  try {
    return await action(db);
  } finally {
    db.close();
  }
}

// ---------- Level 1: Open the database ----------
function openDB() {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("heroes")) {
      db.createObjectStore("heroes", { keyPath: "name" });
    }
    if (!db.objectStoreNames.contains("inventory")) {
      db.createObjectStore("inventory", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("powers")) {
      db.createObjectStore("powers", { keyPath: "id" });
    }
    if (!db.objectStoreNames.contains("journal")) {
      db.createObjectStore("journal", { keyPath: "id", autoIncrement: true });
    }
  };

  return promisify(request).then((db) => {
    db.onversionchange = () => db.close();
    return db;
  });
}

// ---------- Level 1: Heroes ----------
async function createHero(name, heroClass, attributes) {
  const hp = 10 + modifier(attributes.constitution);
  const hero = {
    name,
    heroClass,
    level: 1,
    xp: 0,
    hp,
    maxHp: hp,
    gold: 10,
    attributes,
    createdAt: new Date().toISOString(),
  };

  await withDB((db) => withTransaction(db, "heroes", "readwrite", async (transaction) => {
    const store = transaction.objectStore("heroes");
    await promisify(store.add(hero));
  }));
  return hero;
}

async function getHero(name) {
  return withDB((db) => withTransaction(db, "heroes", "readonly", async (transaction) => {
    return promisify(transaction.objectStore("heroes").get(name));
  }));
}

async function getAllHeroes() {
  return withDB((db) => withTransaction(db, "heroes", "readonly", async (transaction) => {
    return promisify(transaction.objectStore("heroes").getAll());
  }));
}

async function updateHero(hero) {
  await withDB((db) => withTransaction(db, "heroes", "readwrite", async (transaction) => {
    await promisify(transaction.objectStore("heroes").put(hero));
  }));
}

// ---------- Level 2: Inventory ----------
async function addItem(heroName, item) {
  const id = `${heroName}-${item.itemId}`;
  return withDB((db) => withTransaction(db, "inventory", "readwrite", async (transaction) => {
    const store = transaction.objectStore("inventory");
    const existing = await promisify(store.get(id));
    const record = existing
      ? { ...existing, qty: existing.qty + 1 }
      : {
          id,
          hero: heroName,
          itemId: item.itemId,
          name: item.name,
          type: item.type,
          icon: item.icon,
          qty: 1,
        };
    await promisify(store.put(record));
    return record;
  }));
}

async function getInventory(heroName) {
  return withDB((db) => withTransaction(db, "inventory", "readonly", async (transaction) => {
    const records = await promisify(transaction.objectStore("inventory").getAll());
    return records.filter((item) => item.hero === heroName);
  }));
}

async function removeItem(heroName, itemId) {
  const id = `${heroName}-${itemId}`;
  await withDB((db) => withTransaction(db, "inventory", "readwrite", async (transaction) => {
    const store = transaction.objectStore("inventory");
    const item = await promisify(store.get(id));
    if (!item) throw new Error(`"${itemId}" is not in ${heroName}'s inventory.`);
    if (item.qty <= 1) {
      await promisify(store.delete(id));
    } else {
      item.qty -= 1;
      await promisify(store.put(item));
    }
  }));
}

// ---------- Level 2: Powers ----------
async function learnPower(heroName, power) {
  const record = {
    id: `${heroName}-${power.powerId}`,
    hero: heroName,
    powerId: power.powerId,
    name: power.name,
    description: power.description,
    learnAt: power.learnAt,
  };

  await withDB((db) => withTransaction(db, "powers", "readwrite", async (transaction) => {
    await promisify(transaction.objectStore("powers").put(record));
  }));
}

async function getPowers(heroName) {
  return withDB((db) => withTransaction(db, "powers", "readonly", async (transaction) => {
    const records = await promisify(transaction.objectStore("powers").getAll());
    return records.filter((power) => power.hero === heroName);
  }));
}

function deleteRecordsForHero(store, name) {
  return new Promise((resolve, reject) => {
    const request = store.openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (cursor.value && cursor.value.hero === name) cursor.delete();
      cursor.continue();
    };
  });
}

// ---------- Level 2: Delete ----------
async function deleteHero(name) {
  const stores = ["heroes", "inventory", "powers", "journal"];
  await withDB((db) => withTransaction(db, stores, "readwrite", async (transaction) => {
    const heroDelete = promisify(transaction.objectStore("heroes").delete(name));
    const cleanup = [
      deleteRecordsForHero(transaction.objectStore("inventory"), name),
      deleteRecordsForHero(transaction.objectStore("powers"), name),
      deleteRecordsForHero(transaction.objectStore("journal"), name),
    ];
    await Promise.all([heroDelete, ...cleanup]);
  }));
}

// ---------- Level 3: Adventure journal (version 2) ----------
async function addJournal(heroName, text) {
  const entry = {
    hero: heroName,
    text,
    createdAt: new Date().toISOString(),
  };

  await withDB((db) => withTransaction(db, "journal", "readwrite", async (transaction) => {
    await promisify(transaction.objectStore("journal").add(entry));
  }));
}

async function getJournal(heroName) {
  return withDB((db) => withTransaction(db, "journal", "readonly", async (transaction) => {
    const records = await promisify(transaction.objectStore("journal").getAll());
    return records
      .filter((entry) => entry.hero === heroName)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (b.id ?? 0) - (a.id ?? 0));
  }));
}

// IndexedDB 工具类 —— 在浏览器侧缓存全量 tab 列表
//
// 数据库结构:
//   DB:    TabKeepDB
//   Store: tabs(以 TabData.id 为主键)
// 整体逻辑: 每次后台保存都是"全量覆盖"(clear → add 一遍),
//           popup 启动时 loadFromIDB() 拉一遍。
//
// 按职能:
//   1. 常量
//   2. openDB 内部:open + onupgradeneeded 建表
//   3. saveToIDB:全量覆盖
//   4. loadFromIDB:全量读取

// ─────────────────────────────────────────────────────────────
// 1. 常量
// ─────────────────────────────────────────────────────────────
const DB_NAME = "TabKeepDB"
const DB_VERSION = 1
const STORE_NAME = "tabs"

// ─────────────────────────────────────────────────────────────
// 2. openDB:统一处理 open / success / error / onupgradeneeded
// ─────────────────────────────────────────────────────────────
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)

    // 首次打开 / 版本升级时建表
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" })
      }
    }
  })
}

// ─────────────────────────────────────────────────────────────
// 3. saveToIDB:全量写入(覆盖语义,简单粗暴够用)
// ─────────────────────────────────────────────────────────────
export async function saveToIDB<T>(data: T[]): Promise<void> {
  const db = await openDB()
  const transaction = db.transaction(STORE_NAME, "readwrite")
  const store = transaction.objectStore(STORE_NAME)

  // 清空旧数据
  store.clear()

  // 添加新数据
  for (const item of data) {
    store.add(item)
  }

  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

// ─────────────────────────────────────────────────────────────
// 4. loadFromIDB:全量读取(只读事务)
// ─────────────────────────────────────────────────────────────
export async function loadFromIDB<T>(): Promise<T[]> {
  const db = await openDB()
  const transaction = db.transaction(STORE_NAME, "readonly")
  const store = transaction.objectStore(STORE_NAME)
  const request = store.getAll()

  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
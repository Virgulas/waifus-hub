const { contextBridge, ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");

const filePath = path.join(__dirname, "bots.json");

function ensureFile() {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, "[]", "utf-8");
  }
}

function safeRead() {
  ensureFile();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeBots(bots) {
  fs.writeFileSync(filePath, JSON.stringify(bots, null, 2), "utf-8");
}

function migrateAddIds(bots) {
  let changed = false;
  const out = bots.map((b) => {
    if (!b.id) {
      changed = true;
      return { ...b, id: randomUUID() };
    }
    return b;
  });
  if (changed) writeBots(out);
  return out;
}

contextBridge.exposeInMainWorld("electronAPI", {
  loadBots: () => migrateAddIds(safeRead()),

  saveBot: (bot) => {
    const bots = migrateAddIds(safeRead());
    let saved = { ...bot };
    if (!saved.id) saved.id = randomUUID();

    const idx = bots.findIndex((b) => b.id === saved.id);
    if (idx >= 0) {
      bots[idx] = { ...bots[idx], ...saved };
      saved = bots[idx];
    } else {
      bots.push(saved);
    }

    writeBots(bots);
    return saved;
  },

  deleteBot: (botId) => {
    const bots = migrateAddIds(safeRead());
    const next = bots.filter((b) => b.id !== botId);
    const removed = next.length !== bots.length;
    if (removed) writeBots(next);
    return removed;
  },

  startBot: (bot) => ipcRenderer.send("start-bot", bot),
  stopBot: (botId) => ipcRenderer.send("stop-bot", botId),

  onBotStatus: (callback) =>
    ipcRenderer.on("bot-status", (_e, data) => callback(data)),

  // new: ask main process to show file picker
  pickImage: () => ipcRenderer.invoke("pick-image"),
});

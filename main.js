const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let mainWindow;
const bots = {};

function resolveAppPath(...parts) {
  // In dev: project folder; in packaged: .../resources/app
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "app")
    : app.getAppPath();
  return path.join(base, ...parts);
}

app.on("ready", () => {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: true,
      contextIsolation: true,
    },
  });
  mainWindow.loadFile("index.html");
});

ipcMain.on("start-bot", (event, bot) => {
  if (bots[bot.id]) return;

  const botPath = path.join(__dirname, "bot.js");

  // ✅ Electron as Node: prevents extra BrowserWindow
  const child = spawn(process.execPath, [botPath], {
    cwd: path.dirname(botPath),
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      BOT_TOKEN: bot.token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  bots[bot.id] = child;

  child.stdout.on("data", (data) => {
    console.log(`[bot ${bot.id}] ${data}`);
  });

  child.stderr.on("data", (data) => {
    console.error(`[bot ${bot.id} ERROR] ${data}`);
  });

  child.on("exit", (code) => {
    console.log(`[bot ${bot.id}] exited with code ${code}`);
    mainWindow.webContents.send("bot-status", {
      id: bot.id,
      status: "stopped",
    });
    delete bots[bot.id];
  });

  mainWindow.webContents.send("bot-status", {
    id: bot.id,
    status: "running",
  });
});

ipcMain.on("stop-bot", (event, botId) => {
  const child = bots[botId];
  if (!child) return;
  try {
    child.kill("SIGINT");
  } catch (_) {}
  setTimeout(() => {
    if (!child.killed) {
      try {
        child.kill();
      } catch (_) {}
    }
  }, 1500);
});

// ✅ Pick Image handler restored
ipcMain.handle("pick-image", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile"],
    filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const sourcePath = result.filePaths[0];

  // Save to userData/pictures (safe in dev + packaged)
  const picturesDir = path.join(app.getPath("userData"), "pictures");
  if (!fs.existsSync(picturesDir)) {
    fs.mkdirSync(picturesDir, { recursive: true });
  }

  const fileName = Date.now() + "-" + path.basename(sourcePath);
  const destPath = path.join(picturesDir, fileName);

  fs.copyFileSync(sourcePath, destPath);

  // Return file:// path so renderer can use <img src="">
  return "file://" + destPath;
});

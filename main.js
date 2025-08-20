const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let mainWindow;
const bots = {};

function resolveAppPath(...parts) {
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

  const child = spawn(process.execPath, [botPath], {
    cwd: path.dirname(botPath),
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
  // Try graceful stop; fall back if needed
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

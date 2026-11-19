const { app, BrowserWindow, ipcMain, dialog, screen, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const os = require('os');

// Electron 27 在部分 Windows 环境中会反复崩溃 GPU 进程，软件渲染进程也无法通过 GPU 沙箱启动。
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.disableHardwareAcceleration();

let mainWindow;
const remoteWhitelistFile = path.join(app.getPath('userData'), 'remote-whitelist.json');
const remoteExecutableCache = new Map();
let remoteCmdProcess = null;
let remoteCmdPending = null;
let remoteCmdStdout = '';
const REMOTE_CMD_CAPTURE_LIMIT = 2 * 1024 * 1024;

function readRemoteWhitelist() {
  try {
    const values = JSON.parse(fs.readFileSync(remoteWhitelistFile, 'utf8'));
    return Array.isArray(values) ? values.filter(item => typeof item === 'string') : [];
  } catch (_) {
    return [];
  }
}

function writeRemoteWhitelist(values) {
  fs.mkdirSync(path.dirname(remoteWhitelistFile), { recursive: true });
  fs.writeFileSync(remoteWhitelistFile, JSON.stringify(values, null, 2), 'utf8');
}

function getClientLogDirectory() {
  let appPath = app.getAppPath();
  if (app.isPackaged) appPath = path.resolve(appPath, '..');
  return path.join(appPath, 'log');
}

function isWithinRoot(filePath, rootPath) {
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const file = normalize(filePath);
  const root = normalize(rootPath);
  return file === root || file.startsWith(`${root}${path.sep}`);
}

function collectExecutables(rootPath, result = [], depth = 0, baseRootPath = rootPath) {
  if (depth > 2 || !fs.existsSync(rootPath)) return result;
  let entries;
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch (_) {
    return result;
  }
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      collectExecutables(fullPath, result, depth + 1, baseRootPath);
    } else if (/\.(exe|bat|cmd|ps1|lnk)$/i.test(entry.name)) {
      try {
        const stat = fs.statSync(fullPath);
        const id = crypto.createHash('sha256').update(path.resolve(fullPath).toLowerCase()).digest('hex').slice(0, 24);
        remoteExecutableCache.set(id, fullPath);
        result.push({ id, name: entry.name, relativePath: path.relative(baseRootPath, fullPath), size: stat.size });
      } catch (_) {}
    }
  }
  return result;
}

function resetRemoteCmdSession(reason = 'CMD会话已刷新') {
  const child = remoteCmdProcess;
  remoteCmdProcess = null;
  remoteCmdStdout = '';
  if (remoteCmdPending) {
    clearTimeout(remoteCmdPending.timer);
    remoteCmdPending.reject(new Error(reason));
    remoteCmdPending = null;
  }
  if (child && !child.killed) {
    child.removeAllListeners();
    child.stdout?.removeAllListeners();
    child.stderr?.removeAllListeners();
    if (process.platform === 'win32' && Number.isInteger(child.pid)) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.unref();
    } else {
      child.kill();
    }
  }
}

function ensureRemoteCmdSession(cwd) {
  if (remoteCmdProcess && !remoteCmdProcess.killed) return remoteCmdProcess;
  const workingDirectory = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  const child = spawn('cmd.exe', ['/Q', '/D'], {
    cwd: workingDirectory,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  remoteCmdProcess = child;
  remoteCmdStdout = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => {
    remoteCmdStdout += data;
    if (Buffer.byteLength(remoteCmdStdout, 'utf8') > REMOTE_CMD_CAPTURE_LIMIT) {
      resetRemoteCmdSession('CMD输出超过2MB，会话已重置');
      return;
    }
    const pending = remoteCmdPending;
    if (!pending) return;
    const markerIndex = remoteCmdStdout.indexOf(pending.marker);
    if (markerIndex < 0) return;
    const markerEnd = remoteCmdStdout.indexOf('\n', markerIndex);
    if (markerEnd < 0) return;
    const output = remoteCmdStdout.slice(0, markerIndex).replace(/[\r\n]+$/, '');
    const exitCodeText = remoteCmdStdout.slice(markerIndex + pending.marker.length, markerEnd).trim();
    remoteCmdStdout = remoteCmdStdout.slice(markerEnd + 1);
    clearTimeout(pending.timer);
    remoteCmdPending = null;
    pending.resolve({ output, exitCode: Number.parseInt(exitCodeText, 10) || 0 });
  });
  child.stderr.on('data', data => {
    remoteCmdStdout += data;
    if (Buffer.byteLength(remoteCmdStdout, 'utf8') > REMOTE_CMD_CAPTURE_LIMIT) {
      resetRemoteCmdSession('CMD输出超过2MB，会话已重置');
    }
  });
  const handleClose = error => {
    if (remoteCmdProcess !== child) return;
    remoteCmdProcess = null;
    remoteCmdStdout = '';
    if (remoteCmdPending) {
      clearTimeout(remoteCmdPending.timer);
      remoteCmdPending.reject(error instanceof Error ? error : new Error('CMD会话已结束'));
      remoteCmdPending = null;
    }
  };
  child.once('error', handleClose);
  child.once('exit', () => handleClose(new Error('CMD会话已结束')));
  child.stdin.write('chcp 65001>nul\r\n');
  return child;
}

function executeRemoteCommand(command, cwd) {
  const value = String(command || '');
  if (!value.trim() || /[\r\n]/.test(value)) return Promise.reject(new Error('CMD命令必须为单行内容'));
  if (remoteCmdPending) return Promise.reject(new Error('上一条CMD命令仍在执行'));
  const child = ensureRemoteCmdSession(cwd);
  return new Promise((resolve, reject) => {
    const marker = `__MOJANG_CMD_DONE_${crypto.randomBytes(12).toString('hex')}__:`;
    const timer = setTimeout(() => {
      resetRemoteCmdSession('CMD命令执行超时，会话已重置');
    }, 110 * 1000);
    remoteCmdPending = { marker, resolve, reject, timer };
    child.stdin.write(`${value}\r\necho ${marker}%errorlevel%\r\n`, error => {
      if (error && remoteCmdPending?.marker === marker) resetRemoteCmdSession(`CMD命令写入失败：${error.message}`);
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  loadDesktopPermissions();
  mainWindow.loadFile(path.join(app.getAppPath(), 'index.html'));

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

// 渲染进程按用户配置请求最小化窗口。
ipcMain.on('minimize-window', () => {
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
    mainWindow.minimize();
  }
});

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
  if (mainWindow === null) createWindow();
});

// 获取应用数据路径
ipcMain.on('get-app-data-path', (event) => {
  const appDataPath = path.join(app.getPath('userData'), 'genshin-assistant');
  // 确保目录存在
  if (!fs.existsSync(appDataPath)) {
    fs.mkdirSync(appDataPath, { recursive: true });
  }
  event.returnValue = appDataPath;
});

const clientFolder = path.dirname(app.getPath('exe'));
const configPath = path.join(clientFolder, 'config.json');
const selectedFolders = new Set();
const selectedFiles = new Set();
const typedExecutables = new Set();
ipcMain.on('typed-schedule-executable', (_event, file) => {
  if (validPath(file)) typedExecutables.add(key(file));
});
let desktopConfig = {};

function key(file) { return path.resolve(file).toLowerCase(); }
function validPath(file) { return typeof file === 'string' && path.isAbsolute(file); }
function loadDesktopPermissions() {
  try { desktopConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) { return; }
  if (validPath(desktopConfig.bgiFolder)) selectedFolders.add(key(desktopConfig.bgiFolder));
  for (const schedule of desktopConfig.schedules || []) {
    const folder = schedule.action?.config?.jsFolder;
    if (validPath(folder)) selectedFolders.add(key(folder));
    for (const file of [schedule.trigger?.config?.filePath, schedule.action?.config?.filePath]) {
      if (validPath(file)) selectedFiles.add(key(file));
    }
  }
}

function groupDirectories() {
  const folders = (desktopConfig.schedules || []).filter(s => s.trigger?.type === 'trigger-ride')
    .map(s => s.action?.config?.jsFolder).filter(validPath);
  if (validPath(desktopConfig.bgiFolder)) folders.push(path.join(desktopConfig.bgiFolder, 'User', 'JsScript', 'ArtifactsGroupPurchasing'));
  return folders;
}

function isDefaultGroup(folder, bgi) {
  return validPath(folder) && validPath(bgi) && key(folder) === key(path.join(bgi, 'User', 'JsScript', 'ArtifactsGroupPurchasing'));
}

function isScriptCommand(file, bgi) {
  return validPath(bgi) && ['AutoMojang', 'AAA-Artifacts-Bulk-Supply', 'ArtifactsGroupPurchasing']
    .some(script => key(file) === key(path.join(bgi, 'User', 'JsScript', script, 'command.json')));
}

function validateDesktopConfig(config) {
  const bgi = config.bgiFolder;
  if (bgi && (!validPath(bgi) || !selectedFolders.has(key(bgi)))) throw new Error('请在本机选择 BetterGI 文件夹');
  for (const schedule of config.schedules || []) {
    const folder = schedule.action?.config?.jsFolder;
    if (validPath(folder) && !selectedFolders.has(key(folder)) && !isDefaultGroup(folder, bgi)) throw new Error('未选择联机脚本目录');
    for (const file of [schedule.trigger?.config?.filePath, schedule.action?.config?.filePath]) {
      if (validPath(file) && !selectedFiles.has(key(file)) && !(schedule.action?.config?.filePath === file && typedExecutables.has(key(file))) && !isScriptCommand(file, bgi)) throw new Error('未选择调度文件');
    }
  }
}

function desktopFile(file, writing) {
  if (typeof file !== 'string' || !file) throw new Error('文件路径无效');
  const absolute = path.resolve(file);
  if (key(absolute) === key(configPath) || selectedFiles.has(key(absolute)) || isScriptCommand(absolute, desktopConfig.bgiFolder)) return absolute;
  const template = /^(?:modelUser|modelUserLcb)[\\/](OneDragon|ScriptGroup)[\\/]([^\\/:]+\.json)$/i.exec(file);
  if (template && !writing) {
    const roots = [clientFolder, app.getAppPath()];
    return roots.map(root => path.join(root, file)).find(p => fs.existsSync(p)) || path.join(clientFolder, file);
  }
  if (validPath(desktopConfig.bgiFolder)) {
    const relative = path.relative(path.join(desktopConfig.bgiFolder, 'User'), absolute);
    if (/^(OneDragon|ScriptGroup)[\\/][^\\/:]+\.json$/i.test(relative)) return absolute;
  }
  if (groupDirectories().some(dir => key(absolute) === key(path.join(dir, writing ? '匹配信息.json' : 'manifest.json')))) return absolute;
  throw new Error('文件不属于本机配置');
}

ipcMain.on('get-app-path', event => { event.returnValue = clientFolder; });

ipcMain.handle('capture-desktop', async (_event, options = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('主窗口不可用');
  const display = screen.getDisplayMatching(mainWindow.getBounds());
  const scaleFactor = Math.max(1, Number(display.scaleFactor) || 1);
  const sourceWidth = Math.max(1, Math.round(display.bounds.width * scaleFactor));
  const sourceHeight = Math.max(1, Math.round(display.bounds.height * scaleFactor));
  const maxWidth = Math.max(360, Math.min(3840, Math.round(Number(options.maxWidth) || 1080)));
  const scale = Math.min(1, maxWidth / sourceWidth);
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: sourceWidth, height: sourceHeight }
  });
  const displayId = String(display.id);
  const source = sources.find(item => item.display_id === displayId) || (sources.length === 1 ? sources[0] : null);
  if (!source || source.thumbnail.isEmpty()) throw new Error('无法获取桌面画面');
  const image = source.thumbnail.resize({ width, height, quality: 'good' });
  return { base64: image.toJPEG(72).toString('base64'), width, height };
});

ipcMain.handle('list-log-files', async (_event, { kind = 'client', bgiFolder = '' } = {}) => {
  if (kind === 'bgi' && !bgiFolder) return [];
  if (kind === 'bgi' && key(bgiFolder) !== key(desktopConfig.bgiFolder || '.')) throw new Error('未选择 BetterGI 目录');
  const root = kind === 'bgi' ? path.join(String(bgiFolder || ''), 'log') : getClientLogDirectory();
  if (!root || !fs.existsSync(root)) return [];
  const files = [];
  const walk = (dir, depth = 0) => {
    if (depth > 2) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.(log|txt|json)$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(full);
          files.push({ path: path.relative(root, full), size: stat.size, modifiedAt: stat.mtimeMs });
        } catch (_) {}
      }
    }
  };
  walk(root);
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
});

ipcMain.handle('read-log-tail', async (_event, { kind = 'client', bgiFolder = '', filePath, bytes = 64 } = {}) => {
  if (kind === 'bgi' && !bgiFolder) throw new Error('未配置BetterGI文件夹');
  if (kind === 'bgi' && key(bgiFolder) !== key(desktopConfig.bgiFolder || '.')) throw new Error('未选择 BetterGI 目录');
  const root = kind === 'bgi' ? path.join(String(bgiFolder || ''), 'log') : getClientLogDirectory();
  const resolved = path.resolve(root, String(filePath || ''));
  if (!isWithinRoot(resolved, root) || !fs.existsSync(resolved)) throw new Error('日志文件不存在');
  const realRoot = fs.realpathSync(root);
  const realResolved = fs.realpathSync(resolved);
  if (!isWithinRoot(realResolved, realRoot)) throw new Error('日志路径无效');
  const stat = fs.statSync(resolved);
  const length = Math.min(Math.max(1, Number(bytes) || 64) * 1024, stat.size, 4 * 1024 * 1024);
  const fd = fs.openSync(resolved, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return { filePath, bytes: length, base64: buffer.toString('base64') };
  } finally {
    fs.closeSync(fd);
  }
});

ipcMain.handle('list-remote-executables', async () => {
  remoteExecutableCache.clear();
  const folders = readRemoteWhitelist();
  const existingFolders = folders.filter(folder => fs.existsSync(folder));
  return { folders, files: existingFolders.flatMap(folder => collectExecutables(folder).map(item => ({ ...item, folder })) ) };
});

ipcMain.handle('add-remote-whitelist-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return readRemoteWhitelist();
  const selected = path.resolve(result.filePaths[0]);
  const folders = readRemoteWhitelist();
  if (!folders.some(folder => path.resolve(folder).toLowerCase() === selected.toLowerCase())) folders.push(selected);
  writeRemoteWhitelist(folders);
  return folders;
});

ipcMain.handle('remove-remote-whitelist-folder', async (_event, folderPath) => {
  const target = path.resolve(String(folderPath || ''));
  const folders = readRemoteWhitelist();
  const remaining = folders.filter(folder => path.resolve(folder).toLowerCase() !== target.toLowerCase());
  writeRemoteWhitelist(remaining);
  remoteExecutableCache.clear();
  return remaining;
});

ipcMain.handle('run-remote-executable', async (_event, { id } = {}) => {
  const filePath = remoteExecutableCache.get(String(id || ''));
  const folders = readRemoteWhitelist().filter(folder => fs.existsSync(folder));
  if (!filePath || !folders.some(folder => isWithinRoot(filePath, folder)) || !fs.existsSync(filePath)) throw new Error('可执行文件不在白名单中');
  const realFile = fs.realpathSync(filePath);
  if (!folders.some(folder => isWithinRoot(realFile, fs.realpathSync(folder)))) throw new Error('可执行文件不在白名单中');
  if (path.extname(filePath).toLowerCase() === '.lnk') {
    const error = await shell.openPath(filePath);
    if (error) throw new Error(`快捷方式启动失败: ${error}`);
    return { pid: null, name: path.basename(filePath) };
  }
  const ext = path.extname(filePath).toLowerCase();
  const command = ext === '.bat' || ext === '.cmd' || ext === '.ps1' ? 'cmd.exe' : filePath;
  const args = ext === '.bat' || ext === '.cmd'
    ? ['/d', '/s', '/c', filePath]
    : ext === '.ps1'
      ? ['/d', '/s', '/c', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', filePath]
      : [];
  const child = spawn(command, args, { cwd: path.dirname(filePath), detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return { pid: child.pid, name: path.basename(filePath) };
});

ipcMain.handle('execute-remote-command', async (_event, { command, cwd } = {}) => {
  if (desktopConfig.allowRemoteCmd !== true) throw new Error('本机未允许远程命令');
  return executeRemoteCommand(command, cwd);
});

ipcMain.handle('reset-remote-command-session', async () => {
  resetRemoteCmdSession();
  return true;
});

// 本机选定的调度与 BetterGI 文件。
ipcMain.handle('read-file', (_event, file) => fs.readFileSync(desktopFile(file, false), 'utf8'));
ipcMain.handle('write-file', (_event, { filePath, content }) => {
  const file = desktopFile(filePath, true);
  let next;
  if (key(file) === key(configPath)) {
    next = JSON.parse(content);
    validateDesktopConfig(next);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  if (next) desktopConfig = next;
  return true;
});

function commandSnapshot(filePath) {
  const file = desktopFile(filePath, true);
  const content = fs.readFileSync(file, 'utf8');
  if (!content.trim() || content.trim() === '{}') return null;
  const modified = fs.statSync(file).mtimeMs;
  const id = crypto.createHash('sha256').update(key(file)).update(String(modified)).update(content).digest('hex');
  return { id, modified, content };
}

ipcMain.handle('read-command', (_event, file) => commandSnapshot(file));
ipcMain.handle('consume-command', (_event, { file, id }) => {
  if (commandSnapshot(file)?.id !== id) return false;
  fs.writeFileSync(desktopFile(file, true), '{}', 'utf8');
  return true;
});

ipcMain.handle('start-dragon', (_event, { name, folder }) => {
  if (!name || !validPath(folder) || key(folder) !== key(desktopConfig.bgiFolder || '.')) throw new Error('BetterGI 配置无效');
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(folder, 'BetterGI.exe'), ['startOneDragon', name], {
      cwd: folder, detached: true, stdio: 'ignore', windowsHide: true
    });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
});

for (const [channel, type, allowed] of [
  ['select-folder', 'openDirectory', selectedFolders], ['select-file', 'openFile', selectedFiles]
]) {
  ipcMain.handle(channel, async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: [type] });
    const file = result.filePaths[0];
    if (result.canceled || !file) return null;
    allowed.add(key(file));
    return file;
  });
}

// 执行文件
ipcMain.handle('execute-file', (_event, file) => {
  if (!validPath(file) || !(selectedFiles.has(key(file)) || typedExecutables.has(key(file)))) throw new Error('未选择执行文件');
  const ext = path.extname(file).toLowerCase();
  if (ext === '.lnk') return shell.openPath(file).then(error => !error);
  const script = ext === '.ps1', batch = ext === '.cmd' || ext === '.bat';
  const command = script ? 'powershell.exe' : batch ? 'cmd.exe' : file;
  const args = script ? ['-ExecutionPolicy', 'Bypass', '-File', file] : batch ? ['/d', '/s', '/c', '"' + file + '"'] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => resolve(code === 0));
    child.unref();
  });
});

// 关闭进程
ipcMain.handle('close-process', (_event, processName) => {
  if (!['BetterGI.exe', 'YuanShen.exe'].includes(processName)) throw new Error('进程名无效');
  try { execFileSync('taskkill', ['/F', '/IM', processName, '/FI', 'USERNAME eq ' + process.env.USERNAME], { stdio: 'ignore', windowsHide: true }); }
  catch (error) { if (error.status !== 128) throw error; }
  return true;
});

// 日志功能
ipcMain.handle('write-log', (_event, { level, message }) => {
  try {
    // 创建log文件夹
    const logDir = getClientLogDirectory();
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    // 生成按天分界的日志文件名
    const today = new Date().toISOString().split('T')[0];
    const logFilePath = path.join(logDir, `log-${today}.txt`);
    
    // 生成日志内容
    const timestamp = new Date().toISOString();
    const logContent = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;
    
    // 写入日志文件
    fs.appendFileSync(logFilePath, logContent, 'utf8');
    
    return true;
  } catch (error) {
    console.error('写入日志失败:', error);
    throw error;
  }
});

function memberImagePath(filePath) {
  const dir = path.join(clientFolder, 'namePng');
  if (!validPath(filePath) || key(path.dirname(filePath)) !== key(dir) || !/\.png$/i.test(filePath)) throw new Error('无效的队员图片路径');
  return filePath;
}

ipcMain.handle('read-image-file', (_event, filePath) => {
  const file = memberImagePath(filePath);
  if (fs.statSync(file).size > 100 * 1024) throw new Error('文件大小超过100KB限制');
  const data = fs.readFileSync(file);
  return { success: true, fileName: path.basename(file), base64: data.toString('base64'), sha256: crypto.createHash('sha256').update(data).digest('hex') };
});

// 读取图片元数据（仅返回文件名、大小和 SHA-256，不读取正文）
ipcMain.handle('read-image-metadata', async (_event, filePath) => {
  try {
    memberImagePath(filePath);
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) throw new Error('路径不是文件');
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', resolve);
      stream.on('error', reject);
    });
    return {
      success: true,
      filePath,
      fileName: path.basename(filePath),
      fileSize: stats.size,
      sha256: hash.digest('hex')
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 扫描目录中的 PNG 图片并返回元数据清单
ipcMain.handle('list-image-metadata', async (_event, directoryPath) => {
  try {
    if (!groupDirectories().some(dir => key(directoryPath) === key(path.join(dir, 'targets')))) throw new Error('未选择联机脚本目录');
    const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
    const files = entries
      .filter(entry => entry.isFile() && /\.png$/i.test(entry.name))
      .map(entry => path.join(directoryPath, entry.name));
    const metadata = [];
    for (const filePath of files) {
      const result = await new Promise(resolve => {
        const hash = crypto.createHash('sha256');
        let size = 0;
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => { size += chunk.length; hash.update(chunk); });
        stream.on('end', () => resolve({
          filePath,
          fileName: path.basename(filePath),
          fileSize: size,
          sha256: hash.digest('hex')
        }));
        stream.on('error', () => resolve(null));
      });
      if (result) metadata.push(result);
    }
    return { success: true, files: metadata };
  } catch (error) {
    return { success: false, error: error.message, files: [] };
  }
});

// 保存图片文件（二进制）
ipcMain.handle('save-image-file', async (_event, { filePath, base64 }) => {
  const dir = path.dirname(filePath);
  if (!groupDirectories().some(folder => key(dir) === key(path.join(folder, 'targets'))) ||
      !/^[^<>:"/\\|?*\u0000-\u001f]+\.png$/i.test(path.basename(filePath))) throw new Error('无效的队员图片路径');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 100 * 1024 || !bytes.length) throw new Error('图片大小无效');
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, bytes);
  return true;
});

// 只接受两种固定发布包。下载、校验和启动更新器均由主进程完成。
const releaseOrigin = 'http://121.41.2.163:41013';
let activeUpdate = null;

ipcMain.handle('cancel-update', (_event, id) => {
  if (activeUpdate?.id === id && !activeUpdate.committed) activeUpdate.controller.abort();
});

ipcMain.handle('install-update', async (event, { id, kind, folder }) => {
  const isMain = kind === 'main';
  if (activeUpdate || (!isMain && kind !== 'groupPurchasing')) throw new Error('无法开始此更新');
  if (!isMain && (!validPath(folder) || !groupDirectories().some(dir => key(dir) === key(folder)))) throw new Error('未配置团购目录');
  const localDirs = app.isPackaged ? [clientFolder] : [app.getAppPath(), clientFolder];
  const installDir = localDirs.find(dir => fs.existsSync(path.join(dir, 'updater.ps1')));
  if (!installDir) throw new Error('未找到安装目录中的 updater.ps1');
  const controller = new AbortController();
  const update = { id, controller, committed: false };
  activeUpdate = update;
  let archive;
  let temp;
  const progress = info => { if (!event.sender.isDestroyed()) event.sender.send('update-progress', { id, ...info }); };
  try {
    temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mojang-update-'));
    archive = path.join(temp, 'package.zip');
    const response = await fetch(releaseOrigin + (isMain ? '/client/mojang.zip' : '/JsScript/ArtifactsGroupPurchasing.zip'), {
      signal: controller.signal, redirect: 'error'
    });
    if (!response.ok) throw new Error('下载更新包失败 HTTP ' + response.status);
    let bytes = 0;
    const total = Number(response.headers.get('content-length'));
    const stream = require('stream').Readable.fromWeb(response.body);
    stream.on('data', chunk => { bytes += chunk.length; progress({ bytes, total }); });
    await pipeline(stream, fs.createWriteStream(archive, { flags: 'wx' }), { signal: controller.signal });
    if (total && total !== bytes) throw new Error('更新包下载不完整');
    const target = isMain ? installDir : folder;
    await fs.promises.mkdir(target, { recursive: true });
    progress({ phase: '正在解压并校验更新包…' });
    await new Promise((resolve, reject) => {
      controller.signal.throwIfAborted();
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', path.join(installDir, 'updater.ps1'), archive, target, kind, String(isMain), 'handshake'],
        { detached: isMain, stdio: 'ignore', windowsHide: true });
      let timer;
      const stop = () => { clearInterval(timer); controller.signal.removeEventListener('abort', cancel); };
      const cancel = () => {
        if (update.committed) return;
        // 更新器在预处理后读取取消标记，自行释放临时目录和锁。
        try { fs.writeFileSync(archive + '.cancel', 'cancel'); }
        catch (_) { child.kill(); }
      };
      controller.signal.addEventListener('abort', cancel, { once: true });
      child.once('error', error => { stop(); reject(error); });
      child.once('exit', code => {
        stop();
        if (controller.signal.aborted) reject(new Error('已取消更新'));
        else if (code !== 0 || !update.committed) reject(new Error('更新器退出，详见目标目录 updater.log'));
        else resolve();
      });
      timer = setInterval(() => {
        if (controller.signal.aborted || !fs.existsSync(archive + '.ready')) return;
        try {
          fs.writeFileSync(archive + '.commit', 'install', { flag: 'wx' });
          update.committed = true;
          stop();
          progress({ phase: '校验通过，正在安装…' });
          if (isMain) { child.unref(); resolve(); }
        } catch (error) { stop(); child.kill(); reject(error); }
      }, 100);
    });
  } finally {
    activeUpdate = null;
    if (temp && !(isMain && update.committed)) {
      for (const suffix of ['', '.ready', '.commit', '.cancel']) {
        await fs.promises.unlink(path.join(temp, 'package.zip' + suffix)).catch(() => {});
      }
      await fs.promises.rmdir(temp).catch(() => {});
    }
  }
});

// 获取客户端代码哈希（使用key混入，防篡改校验）
// 哈希对象为 app.asar 文件本身，与服务端存储的 asar 一致
ipcMain.handle('get-client-code-hash', (_event, { key } = {}) => {
  try {
    const crypto = require('crypto');
    
    // 读取源码文件（dev 模式直接读源码，打包后 Electron 透明支持从 asar 中读取）
    const appPath = app.getAppPath();
    const files = ['index.html', 'main.js', 'preload.js'];
    let combinedContent = '';
    for (const file of files) {
      try {
        combinedContent += fs.readFileSync(path.join(appPath, file), 'utf8');
      } catch (e2) {
        console.error(`读取代码文件失败: ${file}`, e2.message);
      }
    }
    
    if (!combinedContent) {
      throw new Error('无法读取客户端代码文件');
    }
    
    // SHA256(源码文本 + key)，key 由服务端下发的随机密钥，防止伪造
    const hash = crypto.createHash('sha256').update(Buffer.concat([
      Buffer.from(combinedContent, 'utf8'),
      Buffer.from(key || '')
    ])).digest('hex');
    return hash;
  } catch (error) {
    console.error('计算客户端代码哈希失败:', error);
    throw error;
  }
});

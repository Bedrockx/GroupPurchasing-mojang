const { app, BrowserWindow, ipcMain, dialog, screen, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execSync, spawn, kill } = require('child_process');

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
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');

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

// 获取应用程序路径（exe所在的目录）
ipcMain.on('get-app-path', (event) => {
  let appPath = '';
  try {
    appPath = app.getPath('exe');
    appPath = path.dirname(appPath);
  } catch (e) {
    try {
      appPath = path.dirname(process.execPath);
    } catch (e) {
      appPath = app.getAppPath();
      if (app.isPackaged) {
        appPath = path.resolve(appPath, '..');
        if (appPath.endsWith('resources')) {
          appPath = path.resolve(appPath, '..');
        }
      }
    }
  }
  event.returnValue = appPath;
});

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
  return executeRemoteCommand(command, cwd);
});

ipcMain.handle('reset-remote-command-session', async () => {
  resetRemoteCmdSession();
  return true;
});

// 文件操作
ipcMain.on('read-file', (event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    event.reply('file-content', content);
  } catch (error) {
    event.reply('file-error', error.message);
  }
});

ipcMain.on('delete-file', (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    event.reply('delete-success', true);
  } catch (error) {
    event.reply('delete-error', error.message);
  }
});

// 进程操作
ipcMain.on('start-process', (event, { command, args, cwd }) => {
  try {
    const child = spawn(command, args || [], {
      cwd: cwd || process.cwd(),
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    event.reply('process-started', child.pid);
  } catch (error) {
    event.reply('process-error', error.message);
  }
});

ipcMain.on('kill-process', (event, pid) => {
  try {
    process.kill(pid);
    event.reply('process-killed', true);
  } catch (error) {
    event.reply('process-error', error.message);
  }
});

// 命令执行
ipcMain.on('execute-command', (event, { command, cwd }) => {
  try {
    // 使用exec异步执行命令，避免阻塞主线程
    exec(command, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error) {
        event.reply('command-error', error.message);
      } else {
        event.reply('command-result', stdout);
      }
    });
  } catch (error) {
    event.reply('command-error', error.message);
  }
});

// 选择文件夹
ipcMain.on('select-folder', (event) => {
  dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      event.reply('folder-selected', result.filePaths[0]);
    } else {
      event.reply('folder-selected', null);
    }
  }).catch(error => {
    event.reply('folder-error', error.message);
  });
});

// 选择文件
ipcMain.on('select-file', (event) => {
  dialog.showOpenDialog(mainWindow, {
    properties: ['openFile']
  }).then(result => {
    if (!result.canceled && result.filePaths.length > 0) {
      event.reply('file-selected', result.filePaths[0]);
    } else {
      event.reply('file-selected', null);
    }
  }).catch(error => {
    event.reply('file-error', error.message);
  });
});

// 检查进程状态
ipcMain.on('check-process', (event, processName) => {
  try {
    const username = process.env.USERNAME;
    const cmd = execSync(`tasklist /FI "IMAGENAME eq ${processName}" /FI "USERNAME eq ${username}"`, { encoding: 'utf8' });
    const isRunning = cmd.includes(processName);
    event.reply('process-status', isRunning);
  } catch (error) {
    event.reply('process-status', false);
  }
});

// 执行文件
ipcMain.on('execute-file', (event, filePath) => {
  try {
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      console.error('文件不存在:', filePath);
      event.reply('execute-file-result', false);
      return;
    }
    
    console.log('执行文件:', filePath);
    
    // 使用spawn执行文件
    const { spawn } = require('child_process');
    
    // 根据文件类型选择执行方式
    const ext = path.extname(filePath).toLowerCase();
    let command, args;
    
    if (ext === '.bat' || ext === '.cmd') {
      // 批处理文件
      command = 'cmd.exe';
      args = ['/c', filePath];
    } else if (ext === '.ps1') {
      // PowerShell脚本
      command = 'powershell.exe';
      args = ['-ExecutionPolicy', 'Bypass', '-File', filePath];
    } else {
      // 其他文件（如.exe）直接执行
      command = filePath;
      args = [];
    }
    
    console.log('执行命令:', command, args);
    
    // 执行文件
    const process = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    
    process.on('error', (error) => {
      console.error('执行文件失败:', error);
      event.reply('execute-file-result', false);
    });
    
    process.on('exit', (code) => {
      console.log('文件执行完成，退出码:', code);
      event.reply('execute-file-result', code === 0);
    });
    
    process.unref();
  } catch (error) {
    console.error('执行文件失败:', error);
    event.reply('execute-file-result', false);
  }
});

// 关闭进程
ipcMain.on('close-process', (event, processName) => {
  try {
    const username = process.env.USERNAME;
    execSync(`taskkill /F /IM ${processName} /FI "USERNAME eq ${username}"`, { stdio: 'ignore' });
    event.reply('process-closed', true);
  } catch (error) {
    event.reply('process-closed', true); // 即使失败也视为已关闭
  }
});

// 日志功能
ipcMain.on('write-log', (event, { level, message }) => {
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
    
    event.reply('log-success', true);
  } catch (error) {
    console.error('写入日志失败:', error);
    event.reply('log-error', error.message);
  }
});

// 写入文件
ipcMain.on('write-file', (event, { filePath, content, requestId }) => {
  try {
    // 确保文件所在目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 写入文件
    fs.writeFileSync(filePath, content, 'utf8');
    
    if (requestId) {
      event.reply(`write-file-success-${requestId}`, true);
    } else {
      event.reply('write-file-success', true);
    }
  } catch (error) {
    console.error('写入文件失败:', error);
    if (requestId) {
      event.reply(`write-file-error-${requestId}`, error.message);
    } else {
      event.reply('write-file-error', error.message);
    }
  }
});

// 获取文件内容
ipcMain.on('get-file-content', (event, { filePath }) => {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      event.reply('file-content-result', { filePath, content, success: true });
    } else {
      event.reply('file-content-result', { filePath, content: '', success: false, error: '文件不存在' });
    }
  } catch (error) {
    event.reply('file-content-result', { filePath, content: '', success: false, error: error.message });
  }
});

// 读取图片文件（二进制）
ipcMain.on('read-image-file', (event, { filePath }) => {
  try {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      const fileSize = stats.size;
      
      // 检查文件大小是否超过100KB
      const maxSize = 100 * 1024; // 100KB
      if (fileSize > maxSize) {
        event.reply('image-file-result', { success: false, error: '文件大小超过100KB限制' });
        return;
      }
      
      // 读取文件内容为base64
      const content = fs.readFileSync(filePath);
      const base64 = content.toString('base64');
      
      event.reply('image-file-result', { 
        success: true, 
        filePath, 
        base64, 
        fileName: path.basename(filePath),
        fileSize 
      });
    } else {
      event.reply('image-file-result', { success: false, error: '文件不存在' });
    }
  } catch (error) {
    event.reply('image-file-result', { success: false, error: error.message });
  }
});

// 保存图片文件（二进制）
ipcMain.on('save-image-file', (event, { filePath, base64 }) => {
  try {
    // 确保目录存在
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    // 将base64转换为buffer并写入文件
    const buffer = Buffer.from(base64, 'base64');
    fs.writeFileSync(filePath, buffer);
    
    event.reply('save-image-result', { success: true, filePath });
  } catch (error) {
    event.reply('save-image-result', { success: false, error: error.message });
  }
});

// 获取客户端代码哈希（使用key混入，防篡改校验）
// 哈希对象为 app.asar 文件本身，与服务端存储的 asar 一致
ipcMain.on('get-client-code-hash', (event, { key } = {}) => {
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
      event.reply('client-code-hash', { success: false, error: '无法读取客户端代码文件' });
      return;
    }
    
    // SHA256(源码文本 + key)，key 由服务端下发的随机密钥，防止伪造
    const hash = crypto.createHash('sha256').update(Buffer.concat([
      Buffer.from(combinedContent, 'utf8'),
      Buffer.from(key || '')
    ])).digest('hex');
    event.reply('client-code-hash', { success: true, hash });
  } catch (error) {
    console.error('计算客户端代码哈希失败:', error);
    event.reply('client-code-hash', { success: false, error: error.message });
  }
});

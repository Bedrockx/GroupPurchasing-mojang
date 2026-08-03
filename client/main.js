const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync, spawn, kill } = require('child_process');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
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
    const process = spawn(command, args || [], {
      cwd: cwd || process.cwd(),
      detached: true,
      stdio: 'ignore'
    });
    process.unref();
    event.reply('process-started', process.pid);
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
    // 获取应用程序路径
    let appPath = app.getAppPath();
    if (app.isPackaged) {
      appPath = path.resolve(appPath, '..');
    }
    
    // 创建log文件夹
    const logDir = path.join(appPath, 'log');
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

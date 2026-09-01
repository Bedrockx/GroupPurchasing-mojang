const { ipcRenderer } = require('electron');

// 直接暴露API给渲染进程（因为contextIsolation: false）
window.electronAPI = {
  // 窗口控制
  minimizeWindow: () => {
    ipcRenderer.send('minimize-window');
  },
  // 获取应用数据路径
  getAppDataPath: () => {
    return ipcRenderer.sendSync('get-app-data-path');
  },
  // 获取应用程序路径（exe所在的目录）
  getAppPath: () => {
    return ipcRenderer.sendSync('get-app-path');
  },
  // 文件操作
  readFile: (filePath, callback) => {
    ipcRenderer.once('file-content', (event, content) => callback(null, content));
    ipcRenderer.once('file-error', (event, error) => callback(error, null));
    ipcRenderer.send('read-file', filePath);
  },
  deleteFile: (filePath, callback) => {
    ipcRenderer.once('delete-success', (event, success) => callback(null, success));
    ipcRenderer.once('delete-error', (event, error) => callback(error, null));
    ipcRenderer.send('delete-file', filePath);
  },
  // 选择文件夹
  selectFolder: () => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('folder-selected', (event, folderPath) => resolve(folderPath));
      ipcRenderer.once('folder-error', (event, error) => reject(error));
      ipcRenderer.send('select-folder');
    });
  },
  // 选择文件
  selectFile: () => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('file-selected', (event, filePath) => resolve(filePath));
      ipcRenderer.once('file-error', (event, error) => reject(error));
      ipcRenderer.send('select-file');
    });
  },
  // 进程操作
  startProcess: (command, args, cwd) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('process-started', (event, pid) => resolve(pid));
      ipcRenderer.once('process-error', (event, error) => reject(error));
      ipcRenderer.send('start-process', { command, args, cwd });
    });
  },
  killProcess: (pid) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('process-killed', (event, success) => resolve(success));
      ipcRenderer.once('process-error', (event, error) => reject(error));
      ipcRenderer.send('kill-process', pid);
    });
  },
  // 命令执行
  executeCommand: (command, cwd) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('command-result', (event, result) => resolve(result));
      ipcRenderer.once('command-error', (event, error) => reject(error));
      ipcRenderer.send('execute-command', { command, cwd });
    });
  },
  // 进程状态检查
  checkProcess: (processName) => {
    return new Promise((resolve) => {
      ipcRenderer.once('process-status', (event, isRunning) => resolve(isRunning));
      ipcRenderer.send('check-process', processName);
    });
  },
  // 关闭进程
  closeProcess: (processName) => {
    return new Promise((resolve) => {
      ipcRenderer.once('process-closed', (event, success) => resolve(success));
      ipcRenderer.send('close-process', processName);
    });
  },
  // 日志功能
  writeLog: (level, message) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('log-success', (event, success) => resolve(success));
      ipcRenderer.once('log-error', (event, error) => reject(error));
      ipcRenderer.send('write-log', { level, message });
    });
  },
  // 写入文件
  writeFile: (filePath, content, callback) => {
    const requestId = Date.now() + Math.random();
    const successChannel = `write-file-success-${requestId}`;
    const errorChannel = `write-file-error-${requestId}`;
    
    ipcRenderer.once(successChannel, (event, success) => callback(null, success));
    ipcRenderer.once(errorChannel, (event, error) => callback(error, null));
    ipcRenderer.send('write-file', { filePath, content, requestId });
  },
  // 获取文件内容
  getFileContent: (filePath) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('file-content-result', (event, result) => {
        if (result.success) {
          resolve(result.content);
        } else {
          reject(result.error);
        }
      });
      ipcRenderer.send('get-file-content', { filePath });
    });
  },
  // 读取图片文件（二进制）
  readImageFile: (filePath) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('image-file-result', (event, result) => {
        if (result.success) {
          resolve(result);
        } else {
          reject(result.error);
        }
      });
      ipcRenderer.send('read-image-file', { filePath });
    });
  },
  // 保存图片文件（二进制）
  saveImageFile: (filePath, base64) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('save-image-result', (event, result) => {
        if (result.success) {
          resolve(result);
        } else {
          reject(result.error);
        }
      });
      ipcRenderer.send('save-image-file', { filePath, base64 });
    });
  },
  // 执行文件
  executeFile: (filePath) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('execute-file-result', (event, success) => resolve(success));
      ipcRenderer.send('execute-file', filePath);
    });
  },
  // 获取客户端代码哈希（混入随机key，防篡改校验）
  getCodeHash: (key) => {
    return new Promise((resolve, reject) => {
      ipcRenderer.once('client-code-hash', (event, result) => {
        if (result.success) {
          resolve(result.hash);
        } else {
          reject(result.error);
        }
      });
      ipcRenderer.send('get-client-code-hash', { key: key || '' });
    });
  }
};

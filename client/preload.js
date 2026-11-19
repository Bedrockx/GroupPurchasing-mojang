const { contextBridge, ipcRenderer } = require('electron');

// 手工输入的可执行文件与对话框选择同样有效。只有本机输入事件可登记该路径。
window.addEventListener('change', event => {
  if (event.isTrusted && event.target?.id === 'execute-file-path' && event.target.value.trim()) {
    ipcRenderer.send('typed-schedule-executable', event.target.value.trim());
  }
}, true);

// 渲染层只能调用客户端实际使用的操作；请求与响应由 invoke 一一对应。
contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  getAppPath: () => ipcRenderer.sendSync('get-app-path'),
  captureDesktop: options => ipcRenderer.invoke('capture-desktop', options),
  listLogFiles: (kind, bgiFolder) => ipcRenderer.invoke('list-log-files', { kind, bgiFolder }),
  readLogTail: (kind, bgiFolder, filePath, bytes) => ipcRenderer.invoke('read-log-tail', { kind, bgiFolder, filePath, bytes }),
  listRemoteExecutables: () => ipcRenderer.invoke('list-remote-executables'),
  addRemoteWhitelistFolder: () => ipcRenderer.invoke('add-remote-whitelist-folder'),
  removeRemoteWhitelistFolder: folder => ipcRenderer.invoke('remove-remote-whitelist-folder', folder),
  runRemoteExecutable: id => ipcRenderer.invoke('run-remote-executable', { id }),
  executeRemoteCommand: (command, cwd) => ipcRenderer.invoke('execute-remote-command', { command, cwd }),
  resetRemoteCommandSession: () => ipcRenderer.invoke('reset-remote-command-session'),
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  selectLaicaiDirectory: () => ipcRenderer.invoke('laicai-select-directory'),
  startLaicaiWorker: id => ipcRenderer.invoke('laicai-start-worker',id),
  publishLaicai: (directory,message) => ipcRenderer.invoke('laicai-publish',{directory,message}),
  bindLaicaiOwner: (directory,owner) => ipcRenderer.invoke('laicai-bind-owner',{directory,owner}),
  holdLaicaiOwner: (directory,owner) => {
    const result=ipcRenderer.sendSync('laicai-hold-owner',{directory,owner});
    if (!result?.ok) throw new Error(result?.reason || '未能保存本机任务隔离归属');
  },
  clearLaicaiTaskInput: (directory,owner) => ipcRenderer.invoke('laicai-clear-task-input',{directory,owner}),
  laicaiEvents: directory => ipcRenderer.invoke('laicai-events',directory),
  consumeLaicai: (directory,id,side) => ipcRenderer.invoke('laicai-consume',{directory,id,side}),
  laicaiVersion: folder => ipcRenderer.invoke('laicai-version', folder),
  selectFile: () => ipcRenderer.invoke('select-file'),
  startProcess: (command, args, folder) => {
    if (command !== 'BetterGI.exe' || args?.[0] !== 'startOneDragon') return Promise.reject(new Error('无效的一条龙任务'));
    return ipcRenderer.invoke('start-dragon', { name: args[1], folder });
  },
  closeProcess: name => ipcRenderer.invoke('close-process', name),
  writeLog: (level, message) => ipcRenderer.invoke('write-log', { level, message }),
  readFile: (file, callback) => ipcRenderer.invoke('read-file', file).then(data => callback(null, data), error => callback(error.message)),
  getFileContent: file => ipcRenderer.invoke('read-file', file),
  readCommand: file => ipcRenderer.invoke('read-command', file),
  consumeCommand: (file, id) => ipcRenderer.invoke('consume-command', { file, id }),
  writeFile: (filePath, content, callback) => ipcRenderer.invoke('write-file', { filePath, content })
    .then(result => callback(null, result), error => callback(error.message)),
  readImageFile: file => ipcRenderer.invoke('read-image-file', file),
  readImageMetadata: file => ipcRenderer.invoke('read-image-metadata', file),
  listImageMetadata: dir => ipcRenderer.invoke('list-image-metadata', dir),
  saveImageFile: (filePath, base64) => ipcRenderer.invoke('save-image-file', { filePath, base64 }),
  executeFile: file => ipcRenderer.invoke('execute-file', file),
  getCodeHash: key => ipcRenderer.invoke('get-client-code-hash', { key }),
  installUpdate: request => ipcRenderer.invoke('install-update', request),
  cancelUpdate: id => ipcRenderer.invoke('cancel-update', id),
  onUpdateProgress: handler => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('update-progress', listener);
    return () => ipcRenderer.removeListener('update-progress', listener);
  }
});

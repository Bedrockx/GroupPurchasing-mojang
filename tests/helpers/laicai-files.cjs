const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');

// 载入整个主进程，调用正式注册的 IPC。文件与目录选择均限制在测试临时目录。
function createDesktopFiles(directory, disk = fs) {
  const source = path.join(__dirname, '../../client/main.js');
  const localRequire = createRequire(source);
  const handlers = new Map();
  let selected;
  const noop = () => {};
  const electron = {
    app:{getPath:key => key === 'exe' ? path.join(directory, 'client.exe') : directory,
      commandLine:{appendSwitch:noop}, disableHardwareAcceleration:noop, on:noop},
    ipcMain:{on:noop, handle:(name, fn) => handlers.set(name,fn)},
    dialog:{showOpenDialog:async () => ({filePaths:[selected], canceled:false}),
      showMessageBox:async()=>({response:confirmEnd?1:0})},
  };
  vm.runInNewContext(fs.readFileSync(source,'utf8'), {
    __dirname:path.dirname(source), console, process:{platform:process.platform},
    require:name => name === 'electron' ? electron : name === 'fs' ? disk : localRequire(name),
  }, {filename:source});
  const invoke = (name, arg) => handlers.get('laicai-' + name)({},arg);
  let confirmEnd=false;
  return {
    confirmRecovery(value) { confirmEnd=value; },
    bind:(directory,owner) => invoke('bind-owner',{directory,owner}),
    recover:(directory,owner) => invoke('clear-task-input',{directory,owner}),
    async select(folder) { selected = folder; await invoke('select-directory'); },
    publish:(directory,message) => invoke('publish',{directory,message}),
    events:directory => Array.from(invoke('events',directory)),
    consume:(directory,side,id) => invoke('consume',{directory,side,id}),
  };
}

// LimitedFile 的读目录结果相对于脚本根。文本写入返回 bool，无法写入时不抛异常。
function limitedFile(root, fs = require('node:fs')) {
  function resolve(name) {
    const file = path.resolve(root,name);
    if (file !== root && !file.startsWith(root + path.sep)) throw Error('超出脚本目录');
    return file;
  }
  return {
    IsFolder(name) {
      try { return fs.lstatSync(resolve(name)).isDirectory(); } catch { return false; }
    },
    ReadPathSync(name) {
      const directory = resolve(name);
      try { return fs.readdirSync(directory).map(child => path.join(name,child)); } catch { return []; }
    },
    ReadTextSync(name) {
      try { return fs.readFileSync(resolve(name),'utf8'); } catch { return ''; }
    },
    WriteTextSync(name,value,append=false) {
      if (!/\.(?:txt|json)$/i.test(name)) return false;
      try {
        const target = resolve(name);
        fs.mkdirSync(path.dirname(target), {recursive:true});
        fs.writeFileSync(target, value, {flag:append?'a':'w'});
        return true;
      } catch { return false; }
    },
    IsExists:name => fs.existsSync(resolve(name)),
  };
}

module.exports = { createDesktopFiles, limitedFile };

const path=require('node:path');

// 长程模拟用的文件树。短程测试另用 NTFS 核验相同 IPC、交付标记和原子发布。
function memoryDisk() {
  const entries=new Map();
  const locate=p=>path.resolve(p);
  function failure(code,p) { throw Object.assign(Error(code+' '+p),{code}); }
  function item(p) { return entries.get(locate(p)) || failure('ENOENT',p); }
  function put(p,value) {
    const key=locate(p);
    const parent=entries.get(path.dirname(key));
    if(parent)parent.children.add(path.basename(key));
    entries.set(key,value);
  }
  return {
    existsSync:p=>entries.has(locate(p)),realpathSync:p=>{item(p);return locate(p);},
    mkdirSync(p,options={}) {
      if(entries.has(locate(p))) {
        if(!options.recursive || !item(p).children)failure('EEXIST',p);
        return;
      }
      if(options.recursive && !entries.has(path.dirname(locate(p))) && path.dirname(locate(p))!==locate(p)) {
        this.mkdirSync(path.dirname(locate(p)),options);
      }
      put(p,{children:new Set()});
    },
    lstatSync:p=>({isFile:()=>!item(p).children,isDirectory:()=>Boolean(item(p).children)}),
    readdirSync:p=>[...item(p).children].sort(),
    readFileSync:p=>item(p).body,
    writeFileSync(p,body,options) {
      if(options?.flag==='wx' && this.existsSync(p))failure('EEXIST',p);
      put(p,{body:options?.flag==='a' && this.existsSync(p)?item(p).body+body:body});
    },
    linkSync(src,dst) { if(this.existsSync(dst))failure('EEXIST',dst);put(dst,item(src)); },
    renameSync(src,dst) { put(dst,item(src));this.rmSync(src); },
    rmSync(p) { entries.get(path.dirname(locate(p)))?.children.delete(path.basename(p));entries.delete(locate(p)); }
  };
}

module.exports={memoryDisk};

import { IS_STATE_ROOT, WATCHER_ROOT } from './state-roots';

/** Runs on the execution host; paths are resolved there and never supplied by the renderer. */
export const inspectWatchers = String.raw`${WATCHER_ROOT}
const fs=require('node:fs'), path=require('node:path'), cp=require('node:child_process');
const directory=path.join(require('node:os').homedir(),'.local','state','switch','sdk-watchers');
const read=p=>{try{return readJson(p)}catch(e){if(e.code==='ENOENT')return null;throw e}};
const owner=p=>{
 const saved=read(p); if(!saved)return null;
 if(!Number.isSafeInteger(saved.pid)||saved.pid<=0)throw new Error('Invalid host PID');
 try{process.kill(saved.pid,0);return saved.pid}catch(e){if(e.code==='ESRCH')return null;throw e}
};
const tail=p=>{
 let fd;
 try{fd=fs.openSync(p,'r');const size=fs.fstatSync(fd).size, length=Math.min(size,32768), buffer=Buffer.alloc(length);
 fs.readSync(fd,buffer,0,length,size-length);return (size>length?'[Earlier log omitted]\n':'')+buffer.toString('utf8');
 }catch(e){if(e.code==='ENOENT')return '';throw e}finally{if(fd!==undefined)fs.closeSync(fd)}
};
const result=[], logs=[];
for(const root of [watcherRoot(directory,process.argv[1])]){
 const config=read(path.join(root,'config.json'));
 if(config?.session.agentId!==process.argv[1])continue;
 if(process.argv[2]==='logs'){
  for(const file of ['supervisor.log','supervisor/worker.log']){
   const text=tail(path.join(root,file));if(text)logs.push(file+'\n'+text);
  }
  continue;
 }
 const pid=owner(path.join(root,'shared-owner.lock'));
 const supervisorPid=owner(path.join(root,'supervisor','owner.json'));
 let buildHash=null;
 if(supervisorPid){
  try{
   const command=cp.execFileSync('ps',['-p',String(supervisorPid),'-o','command='],{encoding:'utf8'});
   if(!command.includes(root))throw new Error('The saved PID belongs to another process.');
   buildHash=command.match(/shared-host-([a-f0-9]{64})\.mjs/)?.[1]??null;
  }catch(e){if(e.status!==1)throw e}
 }
 result.push({running:pid!==null,enabled:read(path.join(root,'watch.json'))?.enabled??false,
 pid,supervisorPid,buildHash,takenOver:read(path.join(root,'taken-over.json')),
 failure:pid?null:read(path.join(root,'supervisor','failure.json'))?.message??null});
}
console.log(JSON.stringify(process.argv[2]==='logs'?logs.join('\n\n'):result));
`;

/**
 * Every watcher state root for an identity, removed: the one under its current
 * key and any saved under an earlier one. More than one root is an error to run
 * on but not to remove, so unlike the read above this takes them all.
 */
export const removeWatcherRoots = String.raw`${IS_STATE_ROOT}const fs=require('node:fs'),path=require('node:path');const identity=process.argv[1];const base=path.join(require('node:os').homedir(),'.local','state','switch','sdk-watchers');const roots=new Set([path.join(base,require('node:crypto').createHash('sha256').update(identity).digest('hex'))]);if(fs.existsSync(base))for(const name of fs.readdirSync(base).filter(isStateRoot)){try{if(JSON.parse(fs.readFileSync(path.join(base,name,'config.json'),'utf8')).session.agentId===identity)roots.add(path.join(base,name))}catch(e){if(e.code!=='ENOENT')throw e}}for(const root of roots)fs.rmSync(root,{recursive:true,force:true})`;

/**
 * `waitForWatcherStop(root)` for scripts run with `node -e`: returns once
 * neither the watcher nor its supervisor at `root` is alive, and throws if
 * they are still up after 20 s.
 */
export const WAIT_FOR_WATCHER_STOP_FN = String.raw`
function waitForWatcherStop(root) {
  const fs = require('node:fs'), path = require('node:path');
  const files = ['shared-owner.lock', 'supervisor/owner.json'];
  const alive = (file) => {
    try {
      const pid = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).pid;
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid watcher PID');
      process.kill(pid, 0);
      return true;
    } catch (e) {
      if (['ENOENT', 'ESRCH'].includes(e.code)) return false;
      throw e;
    }
  };
  for (let i = 0; i < 100; i++) {
    if (!files.some(alive)) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  throw new Error('The shared watcher has not stopped; retry after checking its log.');
}
`;

export const waitForWatcherStop = String.raw`${WAIT_FOR_WATCHER_STOP_FN}
try { waitForWatcherStop(process.argv[1]); } catch (e) { console.error(e.message); process.exitCode = 1; }
`;

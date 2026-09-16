import { ANTIGRAVITY_LAUNCHER } from './launcher';

const installer = String.raw`const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
(async () => {
 const target = { 'darwin-arm64': ['macos','darwin-arm64'], 'linux-x64': ['linux','linux-x86_64'], 'linux-arm64': ['linux','linux-arm64'] }[process.platform+'-'+process.arch];
 if (!target) throw new Error('Antigravity ACP supports Apple Silicon macOS and Linux x64/ARM64 execution hosts.');
 const version = '1.1.1';
 const base = join(homedir(), '.local','share','switch','antigravity-acp');
 fs.mkdirSync(base,{recursive:true,mode:0o700});
 const stage = fs.mkdtempSync(join(base,'.install-'));
 try {
  const archive=join(stage,'runtime.zip');
  execFileSync('curl',['-fL','--retry','2','--connect-timeout','20','https://dl.google.com/agy-extensions/releases/'+target[0]+'/agy-acp-server-agy_acp_server_'+version+'-'+target[1]+'.zip','-o',archive],{stdio:'inherit'});
  execFileSync('unzip',['-q',archive,'-d',stage],{stdio:'inherit'});
  fs.unlinkSync(archive);
  for (const name of ['agy_acp_server.par','localharness_external']) { if(!fs.statSync(join(stage,name)).isFile()) throw new Error('Incomplete ACP distribution.');fs.chmodSync(join(stage,name),0o755); }
  const root=join(base,version);
  if(!fs.existsSync(root))fs.renameSync(stage,root);
  const bin=join(homedir(),'.local','bin');fs.mkdirSync(bin,{recursive:true});
  const launcher=join(bin,'antigravity-acp');
  const temporary=launcher+'.'+process.pid+'.tmp';
  fs.writeFileSync(temporary,LAUNCHER_SOURCE,{mode:0o755});fs.renameSync(temporary,launcher);
  console.log('Installed Antigravity ACP '+version+'. Sign in with '+launcher+' --login');
 } finally {fs.rmSync(stage,{recursive:true,force:true});}
})().catch(error=>{console.error(error.message);process.exitCode=1});
`;

const script = installer.replace('LAUNCHER_SOURCE', JSON.stringify(ANTIGRAVITY_LAUNCHER));
export const ANTIGRAVITY_INSTALL_COMMAND = "node -e '" + script.replace(/'/g, "'\"'\"'") + "'";

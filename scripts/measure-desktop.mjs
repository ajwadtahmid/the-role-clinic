// Comparable, inference-free process-tree measurements in an isolated X11/D-Bus session.
// Baseline is WebKitGTK MiniBrowser + the shipped browser launcher, not a full browser profile.
import assert from 'node:assert/strict'
import { spawn, execFile as execCallback } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const exec = promisify(execCallback), root=await mkdtemp(join(tmpdir(),'role-clinic-measure-'))
const native=process.argv[2] || '/usr/bin/the-role-clinic-desktop', backend=process.argv[3] || '/usr/libexec/the-role-clinic/backend'
const browser=process.argv[4] || '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser'
const delay=ms=>new Promise(r=>setTimeout(r,ms)), results=[]
let driver, session, instance, data, mode
async function wait(fn){for(let i=0;i<200;i++){try{const v=await fn();if(v)return v}catch{}await delay(100)}throw Error('measurement timed out')}
async function command(path,body,method=body?'POST':'GET'){
 const r=await fetch('http://127.0.0.1:4446'+path,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});const v=(await r.json()).value;if(v?.error)throw Error(JSON.stringify(v));return v
}
const evaluate=script=>command(`/session/${session}/execute/sync`,{script,args:[]})
async function sample(){
 const rows=(await exec('ps',['-eo','pid=,ppid=,args='])).stdout.split('\n').map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);return m&&{pid:+m[1],ppid:+m[2],command:m[3]}}).filter(Boolean)
 const parent=rows.find(r=>mode==='desktop'?r.command===native:r.command.startsWith(`${browser} --automation`));assert.ok(parent,'app process found')
 const ids=new Set([parent.pid,instance.pid]);for(let i=0;i<8;i++)for(const r of rows)if(ids.has(r.ppid))ids.add(r.pid)
 let pssKiB=0,rssKiB=0,cpuTicks=0;const processes=[]
 for(const r of rows.filter(r=>ids.has(r.pid))){try{
  const rollup=await readFile(`/proc/${r.pid}/smaps_rollup`,'utf8'),stat=(await readFile(`/proc/${r.pid}/stat`,'utf8')).split(') ')[1].split(' ')
  const pss=+rollup.match(/^Pss:\s+(\d+)/m)[1],rss=+rollup.match(/^Rss:\s+(\d+)/m)[1];pssKiB+=pss;rssKiB+=rss;cpuTicks+=+stat[11]+ +stat[12];processes.push({...r,pssKiB:pss,rssKiB:rss})
 }catch{}}
 return {pssKiB,rssKiB,cpuTicks,processes}
}
try{
 for(let round=0;round<3;round++)for(mode of ['desktop','browser']){
  data=join(root,mode);const env={...process.env,ROLE_CLINIC_DATA_DIR:data,ROLE_CLINIC_NO_BROWSER:'1',TAURI_WEBVIEW_AUTOMATION:'true'}
  driver=spawn('WebKitWebDriver',['--port=4446','--host=127.0.0.1'],{env,stdio:'ignore'});await wait(async()=> (await fetch('http://127.0.0.1:4446/status')).ok)
  const start=performance.now()
  if(mode==='browser')await exec(join(backend,'role-clinic'),['start','--no-browser'],{env})
  const args=mode==='browser'?['--automation']:[]
  session=(await command('/session',{capabilities:{alwaysMatch:{'webkitgtk:browserOptions':{binary:mode==='desktop'?native:browser,args}}}})).sessionId
  if(mode==='browser')await command(`/session/${session}/url`,{url:`http://127.0.0.1:${JSON.parse(await readFile(join(data,'instance.json'),'utf8')).port}`})
  await wait(()=>evaluate(`return document.body.innerText.includes('Welcome')||document.body.innerText.includes('Private · on this device')`))
  const startupMs=Math.round(performance.now()-start);instance=JSON.parse(await readFile(join(data,'instance.json'),'utf8'))
  await evaluate(`const b=[...document.querySelectorAll('button')].find(b=>b.textContent==='Skip for now');if(b)b.click();return true`)
  await delay(2000);const idle=await sample(),before=performance.now();let peakPssKiB=idle.pssKiB,peakRssKiB=idle.rssKiB
  for(const [hash,title] of [['settings','Settings'],['resume','Résumé'],['tracker','Tracker'],['jobs','Jobs']]){
   await evaluate(`location.hash=${JSON.stringify(hash)};return true`);await wait(()=>evaluate(`return document.querySelector('h1')?.textContent===${JSON.stringify(title)}`));await delay(300)
   const current=await sample();peakPssKiB=Math.max(peakPssKiB,current.pssKiB);peakRssKiB=Math.max(peakRssKiB,current.rssKiB)
  }
  const end=await sample();results.push({mode,round:round+1,workspace:round===0?'first launch, fresh workspace':'repeat launch, existing workspace',startupMs,workflowMs:Math.round(performance.now()-before),idlePssKiB:idle.pssKiB,idleRssKiB:idle.rssKiB,peakPssKiB,peakRssKiB,workflowCpuTicks:end.cpuTicks-idle.cpuTicks,processes:idle.processes})
  const base=`http://127.0.0.1:${instance.port}`;await fetch(base+'/api/app/quit',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({confirm:true,instanceId:instance.instanceId})});await delay(500)
  await command(`/session/${session}`,undefined,'DELETE').catch(()=>{});session=undefined;driver.kill();await delay(300)
 }
 console.log(JSON.stringify({baseline:'WebKitGTK MiniBrowser plus bundled Node browser launcher, same engine and virtual display',conditions:'Three process starts per mode, software graphics, 1280x1024 Xvfb, no inference. First start uses fresh data. Filesystem caches are not purged; these are not disk-cold measurements. PSS apportions shared pages; summed RSS counts them multiple times. Excludes test driver, Xvfb and D-Bus.',cpuTicksPerSecond:Number((await exec('getconf',['CLK_TCK'])).stdout),results},null,2))
}finally{
 if(session)await command(`/session/${session}`,undefined,'DELETE').catch(()=>{});driver?.kill()
 if(instance){const base=`http://127.0.0.1:${instance.port}`;await fetch(base+'/api/app/quit',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({confirm:true,instanceId:instance.instanceId,force:true})}).catch(()=>{})}
 await rm(root,{recursive:true,force:true})
}

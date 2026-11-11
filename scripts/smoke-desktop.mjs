// Run in an isolated X11/D-Bus session; starts WebKitWebDriver on 127.0.0.1:4445.
// Tests the real packaged webview and native dialogs. All records are synthetic; no models run.
import assert from 'node:assert/strict'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const execFile = promisify(execFileCallback)
const binary = resolve(process.argv[2] || '/usr/bin/the-role-clinic-desktop')
const backend = resolve(process.argv[3] || '/usr/libexec/the-role-clinic/backend')
const evidence = process.env.DESKTOP_EVIDENCE_DIR && resolve(process.env.DESKTOP_EVIDENCE_DIR)
const root = await mkdtemp(join(tmpdir(), 'role-clinic-desktop-'))
const data = join(root, 'workspace with spaces ü'), checks = [], samples = []
process.env.ROLE_CLINIC_DATA_DIR = data
process.env.LANG = 'C.UTF-8'
await mkdir(join(root,'test-tools'))
const externalLog=join(root,'external-link.txt')
await writeFile(join(root,'test-tools','xdg-open'),'#!/bin/sh\nprintf "%s\\n" "$1" > "$ROLE_CLINIC_EXTERNAL_LOG"\n')
await chmod(join(root,'test-tools','xdg-open'),0o755)
process.env.PATH=join(root,'test-tools')+':'+process.env.PATH
process.env.ROLE_CLINIC_EXTERNAL_LOG=externalLog
const driverProcess = spawn('WebKitWebDriver', ['--port=4445', '--host=127.0.0.1'], { env: process.env, stdio: ['ignore', 'ignore', 'inherit'] })
let session, base, instance, shellPid
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, limit = 20000) {
  const deadline = Date.now() + limit; let last
  while (Date.now() < deadline) { try { const value = await fn(); if (value) return value } catch (e) { last = e } await sleep(150) }
  throw new Error(`Timed out: ${label}${last ? ` (${last.message})` : ''}`)
}
async function driver(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`http://127.0.0.1:4445${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) })
  const value = (await response.json()).value
  if (value?.error) throw new Error(JSON.stringify(value))
  return value
}
const evaluate = (script, ...args) => driver(`/session/${session}/execute/sync`, { script, args })
const asyncEval = (script, ...args) => driver(`/session/${session}/execute/async`, { script, args })
const text = () => evaluate('return document.body.innerText')
async function button(label) {
  const element = await until(() => evaluate(`const name=(b)=>[...b.childNodes].filter(n=>n.nodeName!=='KBD').map(n=>n.textContent).join('').trim(); const b=[...document.querySelectorAll('button')].find(b=>name(b)===arguments[0] && !b.disabled); if(!b)return false; b.click();return true`, label), `button ${label}`)
  assert.ok(element)
}
async function field(label, value) {
  assert.ok(await evaluate(`const l=[...document.querySelectorAll('label')].find(l=>l.firstChild?.textContent.trim()===arguments[0]);const e=l?.querySelector('input,textarea');if(!e)return false;const p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,arguments[1]);e.dispatchEvent(new Event('input',{bubbles:true}));return true`, label, value), `field ${label}`)
}
async function select(label, value){assert.ok(await evaluate(`const l=[...document.querySelectorAll('label')].find(l=>l.firstChild?.textContent.trim()===arguments[0]);const e=l?.querySelector('select');if(!e)return false;e.value=arguments[1];e.dispatchEvent(new Event('change',{bubbles:true}));return true`,label,value))}
async function route(hash, expected) { await evaluate('location.hash=arguments[0]', hash); await until(async () => (await text()).includes(expected), expected) }
async function api(path, body, method = body ? 'POST' : 'GET', headers = {}) {
  const response = await fetch(base + path, { method, headers: { origin: base, 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const value = await response.json(); assert.ok(response.ok, `${path} ${response.status} ${JSON.stringify(value)}`); return value
}
async function start() {
  const at = performance.now()
  session = (await driver('/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary, args: [] } } } })).sessionId
  await until(async () => (await text()).includes('Welcome') || (await text()).includes('Private · on this device'), 'workspace ready', 40000)
  instance = JSON.parse(await readFile(join(data, 'instance.json'), 'utf8')); base = `http://127.0.0.1:${instance.port}`
  const parent = (await readFile(`/proc/${instance.pid}/stat`, 'utf8')).split(') ')[1].split(' ')[1]
  shellPid = Number(parent)
  samples.push({ startupMs: Math.round(performance.now() - at) })
  assert.equal(await evaluate('return !!window.__TAURI_INTERNALS__'), true)
  assert.equal((await api('/api/app/status')).desktop, true)
}
async function quit() {
  await evaluate('window.__TAURI_INTERNALS__.invoke("quit_app");return true').catch(() => {})
  await until(async () => { try { await stat(join(data, 'instance.json')); return false } catch (e) { return e.code === 'ENOENT' } }, 'backend shutdown')
  await driver(`/session/${session}`, undefined, 'DELETE').catch(() => {}); session = undefined
}
async function nativeKey(...keys) { await execFile('xdotool', ['key', '--clearmodifiers', ...keys]) }
async function clickDialog(title, fraction=0.5){
  const dialog=await until(async()=>(await execFile('xdotool',['search','--onlyvisible','--name',title])).stdout.trim().split('\n').at(-1),title)
  const geometry=(await execFile('xdotool',['getwindowgeometry','--shell',dialog])).stdout
  const width=Number(geometry.match(/^WIDTH=(\d+)/m)[1]),height=Number(geometry.match(/^HEIGHT=(\d+)/m)[1])
  await execFile('xdotool',['mousemove','--window',dialog,String(Math.round(width*fraction)),String(height-18),'click','1'])
}
async function saveLink(selector, destination) {
  assert.ok(await evaluate(`const a=document.querySelector(arguments[0]);if(!a)return false;a.click();return true`, selector), selector)
  const dialog = await until(async () => { const result = await execFile('xdotool', ['search', '--onlyvisible', '--name', 'Save']); return result.stdout.trim().split('\n').at(-1) }, 'native Save dialog')
  await execFile('xdotool', ['windowfocus', '--sync', dialog])
  await sleep(200); await nativeKey('ctrl+l'); await nativeKey('ctrl+a')
  const clip = spawn('xclip', ['-selection', 'clipboard'], { stdio: ['pipe', 'ignore', 'ignore'] }); clip.stdin.end(destination)
  await sleep(150); await nativeKey('ctrl+v'); await sleep(150); await nativeKey('Return'); await sleep(350); await nativeKey('Return')
  await until(async () => (await stat(destination)).size > 0, `saved ${destination}`)
  return readFile(destination)
}
async function importFile(selector, filename) {
  const element = await driver(`/session/${session}/element`, { using: 'css selector', value: selector })
  await driver(`/session/${session}/element/${element['element-6066-11e4-a52e-4f735466cecf']}/value`, { text: filename })
}
async function dbWork(fn) {
  const { createDatabase } = await import(pathToFileURL(join(backend, 'app/apps/server/src/db.js')).href)
  const { sqlite } = createDatabase(data)
  try { return await fn(sqlite) } finally { sqlite.close() }
}
async function memory(label) {
  const rows = (await execFile('ps', ['-eo', 'pid=,ppid=,rss=,args='])).stdout.trim().split('\n').map((line) => { const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m && {pid:+m[1],ppid:+m[2],rssKiB:+m[3],command:m[4]} }).filter(Boolean)
  const shell = rows.find((r) => r.pid === shellPid), ids = new Set(shell ? [shell.pid] : [])
  for (let i=0;i<8;i++) for (const row of rows) if(ids.has(row.ppid))ids.add(row.pid)
  const tree = rows.filter(r=>ids.has(r.pid)); assert.ok(tree.some(r=>r.pid === instance.pid))
  for(const row of tree){const rollup=await readFile(`/proc/${row.pid}/smaps_rollup`,'utf8');row.pssKiB=Number(rollup.match(/^Pss:\s+(\d+)/m)?.[1] || 0)}
  samples.push({ label, rssKiB: tree.reduce((n,r)=>n+r.rssKiB,0), pssKiB:tree.reduce((n,r)=>n+r.pssKiB,0), processes:tree })
}

try {
  if (evidence) await mkdir(evidence, { recursive: true })
  await until(async()=> (await fetch('http://127.0.0.1:4445/status')).ok, 'WebKit driver ready')
  // A new install asks how it will be used. This run exercises the AI pages, so it picks that path, turns AI features on
  // as a finished setup would, and reloads so the page reads the new setting.
  // These choices hold a title and a description, so the exact-text button helper cannot find them.
  await start(); await until(() => evaluate(`const b=[...document.querySelectorAll('.start-choice')].find(b=>b.querySelector('strong')?.textContent.trim()===arguments[0]&&!b.disabled);if(!b)return false;b.click();return true`, 'Also tailor résumés with AI'), 'first-run choice')
  await api('/api/ai-features', { enabled: true }, 'PUT')
  await evaluate('location.hash="#jobs"; location.reload()')
  await until(async () => (await text()).includes('Add your first job'), 'jobs page with AI features on')
  checks.push('native first run')
  await memory('idle after welcome')
  // Capture through actual React controls, including the blocked-site fallback.
  await button('Add your first job'); await button('From a link'); await field('Job link', 'https://www.linkedin.com/jobs/view/fixture'); await button('Fetch details')
  await until(async () => (await text()).includes('not supported for direct capture'), 'paste fallback')
  await button('Paste the description'); await field('Company', 'Desktop Fixture'); await field('Role title', 'TypeScript Engineer'); await field('Job description (optional)', 'Build reliable TypeScript APIs and maintain software systems with our engineering team. This is a synthetic job used only for desktop validation.'); await button('Save job')
  await until(async () => (await api('/api/jobs')).jobs?.length === 1, 'captured job')
  const job = (await api('/api/jobs')).jobs[0], jobId = job.id
  // The app opens the saved job a moment after saving. Wait for that, or it would override the next page we ask for.
  await until(() => evaluate('return location.hash.startsWith("#jobs/")'), 'the saved job opens')
  checks.push('paste capture and URL fallback')
  await api(`/api/jobs/${jobId}/status`, { status: 'saved' }, 'PUT')
  await route(`#tracker?job=${jobId}`, 'Questions and answers')
  await field('Question','Why this team?');await field('Answer','Fixture draft answer.');await button('Save answer')
  await until(async()=>(await api(`/api/jobs/${jobId}`)).answers.length===1,'answer saved')
  const answer=(await api(`/api/jobs/${jobId}`)).answers[0]
  await button('Edit');await field('Answer','I enjoy building reliable APIs.');await button('Save changes')
  await until(async()=>(await api(`/api/jobs/${jobId}`)).answers[0].answer==='I enjoy building reliable APIs.','answer edited')
  await button('Copy answer');assert.equal((await execFile('xclip',['-selection','clipboard','-o'])).stdout,'I enjoy building reliable APIs.')
  const reuseJob=await api('/api/jobs',{company:'Reuse Fixture',title:'Platform Engineer',text:'Maintain reliable software systems and TypeScript APIs. Synthetic desktop answer reuse fixture.'})
  await api(`/api/jobs/${reuseJob.id}/status`,{status:'saved'},'PUT')
  await route('#answers','1 saved answer');await button('Reuse answer');await select('Target application',reuseJob.id);await button('Save answer')
  await until(async()=>(await api(`/api/jobs/${reuseJob.id}`)).answers[0]?.reusedFrom===answer.id,'answer reused')
  checks.push('tracker, answer creation, editing, clipboard and reuse in webview')
  await quit()
  // Seed a grounded draft, exactly as the browser package smoke does. No inference or API costs.
  const { saveMaster, saveProfile, snapshotMaster } = await import(pathToFileURL(join(backend, 'app/apps/server/src/master.js')).href)
  const { emptyMaster, emptyProfile } = await import(pathToFileURL(join(backend, 'app/packages/shared/src/index.js')).href)
  const runId=randomUUID(), outId=randomUUID(), bulletId=randomUUID()
  await dbWork((db) => {
    const master=emptyMaster(); master.roles.push({id:randomUUID(),company:'Source Company',title:'Engineer',start:'2024',end:'Present',bullets:[{id:bulletId,rev:1,text:'Built reliable TypeScript APIs',skills:['TypeScript'],metrics:[],verbs:[],sourceRef:'synthetic fixture'}]}); saveMaster(db,master)
    saveProfile(db,{...emptyProfile(),name:'Sample Candidate',email:'sample@example.test'})
    const hash=snapshotMaster(db), now=new Date().toISOString()
    db.prepare('INSERT INTO runs(id,job_id,kind,status,step,created_at) VALUES(?,?,?,?,?,?)').run(runId,jobId,'tailor','done','complete',now)
    const document={jobId,runId,snapshotHash:hash,summary:null,skillsLine:[],lines:[{outId,text:'Built reliable TypeScript APIs',sourceIds:[bulletId],author:'model',verdict:'grounded',layer1Flags:[],layer2Reason:'Controlled fixture',slopFlags:[]}],scores:[],gaps:[],exportReady:true}
    db.prepare('INSERT INTO tailored(id,job_id,run_id,snapshot_hash,document,created_at) VALUES(?,?,?,?,?,?)').run(runId,jobId,runId,hash,JSON.stringify(document),now)
  })
  await start()
  // Single-instance plugin must not launch another backend or replace its identity.
  const second=spawn(binary,[],{env:process.env,stdio:'ignore'}); await new Promise((r,j)=>{second.once('error',j);second.once('exit',(code)=>code===0?r():j(Error(`second launch ${code}`)))})
  assert.equal(JSON.parse(await readFile(join(data,'instance.json'),'utf8')).instanceId,instance.instanceId); checks.push('second launch reuses native instance')
  await assert.rejects(execFile(join(backend,'role-clinic'),['start','--no-browser'],{env:process.env}),/desktop app/)
  await route(`#jobs/${jobId}`, 'Desktop Fixture'); await button('Résumé')
  // The draft is reviewed on its own page, which the Résumé tab links to.
  await until(() => evaluate(`const a=[...document.querySelectorAll('a')].find(a=>a.textContent.trim()==='Open the review');if(!a)return false;a.click();return true`), 'link to the review')
  await until(async()=>(await text()).includes('Built reliable TypeScript APIs'), 'saved draft')
  await button('Accept'); await until(async () => (await api(`/api/jobs/${jobId}/review`)).review.lines[0].decision === 'accepted', 'review accepted')
  await button('Copy résumé'); assert.ok((await execFile('xclip',['-selection','clipboard','-o'])).stdout.includes('Built reliable TypeScript APIs')); checks.push('native clipboard')
  await button('PDF page')
  await until(() => evaluate(`const c=document.querySelector('.pdf-canvas-proof canvas');if(!c)return false;const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let dark=0;for(let i=0;i<d.length;i+=4)if(d[i+3]&&d[i]<180&&d[i+1]<180&&d[i+2]<180)dark++;return dark>100`), 'actual PDF painted in WebKitGTK',40000)
  await evaluate('document.querySelector(".pdf-canvas-proof").scrollIntoView({block:"center"});return true')
  if(evidence)await writeFile(join(evidence,'pdf-proof.png'),Buffer.from(await driver(`/session/${session}/screenshot`),'base64'))
  checks.push('review acceptance and real PDF canvas')
  await memory('rendered PDF')
  for(const format of ['PDF','DOCX']){
    await button(`Export ${format}`);await until(()=>evaluate('return !!document.querySelector("a.download-artifact")'),`export ${format}`)
    // The previous artifact remains visible while the next export is being made.
    await until(()=>evaluate('return document.querySelector("a.download-artifact")?.textContent.toLowerCase().includes(arguments[0])',`.${format.toLowerCase()}`),`${format} artifact`)
    const bytes=await saveLink('a.download-artifact',join(root,`résumé ${format.toLowerCase()}.${format.toLowerCase()}`));assert.equal(bytes.subarray(0,format==='PDF'?5:2).toString(),format==='PDF'?'%PDF-':'PK')
  }
  checks.push('native Save dialogs for PDF and DOCX')
  const artifacts=(await api(`/api/jobs/${jobId}/artifacts`)).artifacts
  await api(`/api/jobs/${jobId}/status`,{status:'applied',submittedArtifactId:artifacts[0].id},'PUT')
  await api(`/api/jobs/${jobId}/answers/${answer.id}`,{question:'Why this team?',answer:'Edited working copy.',category:'why-us'},'PUT')
  assert.equal((await api(`/api/jobs/${jobId}/submitted`)).answers[0].answer,'I enjoy building reliable APIs.');checks.push('submitted version remains frozen')
  await route('#tracker','Desktop Fixture')
  for(const [selector,name,signature] of [['a[href*="export/xlsx"]','tracker.xlsx','PK'],['a[href*="applications.csv"]','applications.csv','Company'],['a[href*="qa.csv"]','answers.csv','Company']]){
    const bytes=await saveLink(selector,join(root,name));assert.ok(bytes.toString().includes(signature),name)
  }
  checks.push('native Save dialogs for XLSX and CSV')
  await route('#resume','Your master résumé is the source')
  const masterFile=join(root,'master.json');const masterBytes=await saveLink('a[download="role-clinic-master.json"]',masterFile);assert.ok(JSON.parse(masterBytes).master)
  await importFile('input[accept=".json"]',masterFile);await until(async()=> (await text()).includes('Export file checked'),'native JSON file import')
  await importFile('input[accept=".pdf,.docx"]',join(root,'résumé docx.docx'));await until(async()=> (await text()).includes('Check the draft against the source'),'DOCX import');await button('Discard import draft');checks.push('master JSON and DOCX imports')
  await route('#settings','Your data folder');await button('Back up now');await until(()=>evaluate('return document.querySelectorAll(".backup-list .row").length>0'),'database backup')
  const backup=await saveLink('.backup-list .row a',join(root,'backup.sqlite'));assert.equal(backup.subarray(0,15).toString(),'SQLite format 3');checks.push('database backup and native download')
  // Invoke the same production IPC surface; no testing-only permissions exist.
  const rejected=await asyncEval(`const done=arguments[arguments.length-1];Promise.all(['file:///etc/passwd','javascript:alert(1)'].map(url=>window.__TAURI_INTERNALS__.invoke('open_external',{url}).then(()=>false,()=>true))).then(done)`)
  assert.deepEqual(rejected,[true,true])
  const denied=await asyncEval(`const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('save_download',{path:'/api/settings'}).then(()=>done(false),()=>done(true))`);assert.equal(denied,true)
  const forbidden=await fetch(base+'/api/app/welcome',{method:'POST',headers:{origin:'https://evil.example','content-type':'application/json'},body:'{"acknowledged":true}'});assert.equal(forbidden.status,403)
  const csp=(await fetch(base)).headers.get('content-security-policy');assert.ok(csp.includes("object-src 'none'"));checks.push('restricted IPC and unchanged API origin guard')
  await asyncEval(`const done=arguments[arguments.length-1];window.__TAURI_INTERNALS__.invoke('open_external',{url:'https://example.test/fixture'}).then(()=>done(true),e=>done(String(e)))`)
  assert.equal((await until(()=>readFile(externalLog,'utf8'),'external opener')).trim(),'https://example.test/fixture')
  await evaluate('location.href="https://example.test/blocked";return true');await sleep(200);assert.equal(await evaluate('return location.origin'),base);checks.push('HTTP external opener and blocked webview navigation')
  if(evidence)await writeFile(join(evidence,'settings.png'),Buffer.from(await driver(`/session/${session}/screenshot`),'base64'))
  await quit();checks.push('clean close removes backend instance')
  await start()
  const activeRun=randomUUID()
  await dbWork(db=>db.prepare('INSERT INTO runs(id,job_id,kind,status,step,created_at) VALUES(?,?,?,?,?,?)').run(activeRun,jobId,'tailor','running','fixture',new Date().toISOString()))
  await evaluate('window.__TAURI_INTERNALS__.invoke("quit_app");return true')
  const dialog=await until(async()=> (await execFile('xdotool',['search','--onlyvisible','--name','Quit The Role Clinic'])).stdout.trim().split('\n').at(-1),'active run confirmation')
  await execFile('xdotool',['windowfocus','--sync',dialog]);await nativeKey('Escape');await sleep(250)
  assert.equal((await api('/api/app/status')).activeRuns,1)
  await evaluate('window.__TAURI_INTERNALS__.invoke("quit_app");return true')
  await clickDialog('Quit The Role Clinic',0.25)
  await until(async()=>{try{await stat(join(data,'instance.json'));return false}catch(e){return e.code==='ENOENT'}},'confirmed active shutdown')
  await driver(`/session/${session}`,undefined,'DELETE').catch(()=>{});session=undefined
  await start();assert.equal(await dbWork(db=>db.prepare('SELECT status FROM runs WHERE id=?').get(activeRun).status),'failed');await quit();checks.push('active run cancel, confirmed quit and interrupted recovery')
  // The private stdin pipe must stop the owned Node process when the shell crashes.
  await start();const nodePid=instance.pid
  process.kill(shellPid,'SIGKILL')
  await until(async()=>{try{await stat(join(data,'instance.json'));return false}catch(e){return e.code==='ENOENT'}},'orphan backend cleanup')
  assert.throws(()=>process.kill(nodePid,0));await driver(`/session/${session}`,undefined,'DELETE').catch(()=>{});session=undefined;checks.push('shell crash stops owned Node backend')
  await start();process.kill(instance.pid,'SIGKILL');await clickDialog('The Role Clinic stopped');await driver(`/session/${session}`,undefined,'DELETE').catch(()=>{});session=undefined
  await start();assert.equal((await api(`/api/jobs/${jobId}`)).job.company,'Desktop Fixture');await quit();checks.push('backend crash shown and saved data recovered')
  // An existing browser preview owns its data until the user closes it.
  await execFile(join(backend,'role-clinic'),['start','--no-browser'],{env:process.env})
  const browserInstance=JSON.parse(await readFile(join(data,'instance.json'),'utf8'))
  session=(await driver('/session',{capabilities:{alwaysMatch:{'webkitgtk:browserOptions':{binary,args:[]}}}})).sessionId
  await until(async()=>(await readFile(join(data,'app.log'),'utf8')).includes('already in use'),'browser conflict error')
  assert.equal(JSON.parse(await readFile(join(data,'instance.json'),'utf8')).instanceId,browserInstance.instanceId)
  assert.ok(process.kill(browserInstance.pid,0));await clickDialog('The Role Clinic could not start');await driver(`/session/${session}`,undefined,'DELETE').catch(()=>{});session=undefined
  await execFile(join(backend,'role-clinic'),['stop'],{env:process.env});checks.push('browser and desktop refuse competing workspace ownership')
  console.log(JSON.stringify({passed:true,binary,checks,samples,modelCalls:0},null,2))
} catch(error){
  if(session && evidence){try{await execFile('import',['-window','root',join(evidence,'failure.png')]);await writeFile(join(evidence,'failure-text.txt'),await text())}catch{}}
  console.error(await readFile(join(data,'app.log'),'utf8').catch(()=>''));throw error
} finally {
  if(session){await api('/api/app/quit',{confirm:true,instanceId:instance?.instanceId,force:true}).catch(()=>{});await driver(`/session/${session}`,undefined,'DELETE').catch(()=>{})}
  driverProcess.kill()
  await rm(root,{recursive:true,force:true})
}

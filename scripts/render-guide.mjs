import { readFile, writeFile } from 'node:fs/promises'
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
// Inline code, bold, and links to other places in the guide ([text](#section)).
const inline = (text) => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\(#([a-z0-9-]+)\)/g, '<a href="#$2">$1</a>')
const id = (heading) => heading.toLowerCase().split(' ')[0]
const text = await readFile(new URL('../packaging/USER-GUIDE.md', import.meta.url), 'utf8')
const blocks = text.split('\n\n').map((block) => block.startsWith('# ') ? `<h1>${inline(block.slice(2))}</h1>` : block.startsWith('## ') ? `<h2 id="${id(block.slice(3))}">${inline(block.slice(3))}</h2>` : block.startsWith('### ') ? `<h3 id="${id(block.slice(4))}">${inline(block.slice(4))}</h3>` : `<p>${inline(block)}</p>`)
await writeFile(new URL('../apps/web/public/guide.html', import.meta.url), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>The Role Clinic — User guide</title><style>body{font-family:system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 22px;color:#242920;background:#fffefa;line-height:1.7}p{white-space:pre-wrap;overflow-wrap:anywhere}h1,h2,h3{color:#315b45}h2{margin-top:2em}h3{margin-top:1.6em}a{color:#315b45}code{background:#edf0e7;padding:2px 4px;border-radius:3px;font-size:.9em}</style><main>${blocks.join('')}</main></html>\n`)

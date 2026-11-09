import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { Document, Packer, Paragraph, TextRun } from 'docx'
import mammoth from 'mammoth'
import { extractText, getDocumentProxy } from 'unpdf'
import { collapseRepeatedWord, type Master, type ParseCheck, type Profile, type ResumeBlock, type Review } from '../../../packages/shared/src/index.js'

const require = createRequire(import.meta.url)
// pdfmake 0.3's server API differs from the 0.2 DefinitelyTyped API.
type PdfMake = {
  setUrlAccessPolicy(policy: (url: string) => boolean): void;
  setLocalAccessPolicy(policy: (path: string) => boolean): void;
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(definition: unknown): { getBuffer(): Promise<Buffer> };
}
let renderer: PdfMake | undefined
function getRenderer(): PdfMake {
  if (!renderer) {
    renderer = require('pdfmake') as PdfMake
    const fonts = join(dirname(require.resolve('pdfmake/package.json')), 'fonts/Roboto')
    renderer.setUrlAccessPolicy(() => false)
    renderer.setLocalAccessPolicy((path) => ['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Italic.ttf', 'Roboto-MediumItalic.ttf'].some((name) => path === join(fonts, name)))
    renderer.addFonts({ Roboto: { normal: join(fonts, 'Roboto-Regular.ttf'), bold: join(fonts, 'Roboto-Medium.ttf'), italics: join(fonts, 'Roboto-Italic.ttf'), bolditalics: join(fonts, 'Roboto-MediumItalic.ttf') } })
  }
  return renderer
}

const dates = (start: string, end: string) => [start, end].filter(Boolean).join(' – ')
export function resumeBlocks(review: Review, profile: Profile): ResumeBlock[] {
  const blocks: ResumeBlock[] = []
  const add = (id: string, kind: ResumeBlock['kind'], text: string) => { if (text.trim()) blocks.push({ id, kind, text }) }
  add('name', 'name', profile.name)
  add('contact', 'contact', [profile.email, profile.phone, profile.location, ...profile.links].filter(Boolean).join(' · '))
  const summary = review.master.summaries.find((s) => s.id === review.summaryId)
  if (summary) { add('summary-heading', 'heading', 'Summary'); add('summary', 'text', summary.text) }
  for (const [kind, sections] of [['Experience', review.master.roles], ['Projects', review.master.projects]] as const) {
    let heading = false
    for (const section of sections) {
      const lines = review.lines.filter((line) => line.sectionId === section.id && line.decision === 'accepted')
      if (!lines.length) continue
      if (!heading) { add(kind, 'heading', kind); heading = true }
      add(section.id, 'section', [('company' in section ? [section.title, section.company].filter(Boolean).join(' · ') : section.name), dates(section.start, section.end)].filter(Boolean).join(' | '))
      for (const line of lines) add(line.outId, 'bullet', line.text)
    }
  }
  if (review.master.education.length) {
    add('education-heading', 'heading', 'Education')
    for (const item of review.master.education) {
      add(item.id, 'section', [collapseRepeatedWord(item.school), [item.credential, item.field].filter(Boolean).join(', '), dates(item.start, item.end)].filter(Boolean).join(' | '))
      add(`${item.id}-details`, 'text', item.details)
    }
  }
  if (review.skills.length) { add('skills-heading', 'heading', 'Skills'); add('skills', 'text', review.skills.join(' · ')) }
  return blocks
}
const normalize = (text: string) => text.normalize('NFKC').replace(/[\s\u00ad]+/g, '').replace(/[•●]/g, '')
export function checkReadingOrder(blocks: ResumeBlock[], extracted: string): ParseCheck {
  const haystack = normalize(extracted), missing: string[] = []
  let cursor = 0
  for (const block of blocks) {
    const needle = normalize(block.text), index = haystack.indexOf(needle, cursor)
    if (index < 0) missing.push(block.text)
    else cursor = index + needle.length
  }
  return { ok: missing.length === 0, missing }
}
export async function renderPdf(blocks: ResumeBlock[]) {
  const buffer = await getRenderer().createPdf({
    pageSize: 'LETTER', pageMargins: [40, 40, 40, 40],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.15 },
    content: blocks.map((block) => ({
      text: `${block.kind === 'bullet' ? '• ' : ''}${block.text}`,
      fontSize: block.kind === 'name' ? 20 : block.kind === 'heading' ? 11 : block.kind === 'contact' ? 9 : 10,
      bold: ['name', 'heading', 'section'].includes(block.kind),
      margin: [block.kind === 'bullet' ? 8 : 0, block.kind === 'heading' ? 10 : 0, 0, block.kind === 'bullet' ? 4 : 5],
      // Keep section labels with at least their first following line.
      headlineLevel: ['heading', 'section'].includes(block.kind) ? 1 : undefined,
    })),
    pageBreakBefore: (node: { headlineLevel?: number }, container: { getFollowingNodesOnPage(): unknown[] }) => node.headlineLevel === 1 && container.getFollowingNodesOnPage().length === 0,
  }).getBuffer()
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  try {
    const pages = pdf.numPages
    const extracted = (await extractText(pdf, { mergePages: true })).text
    const page = await pdf.getPage(pages), content = await page.getTextContent()
    const bottom = Math.max(40, ...content.items.flatMap((item) => 'transform' in item ? [792 - item.transform[5]] : []))
    return { buffer, pages, lastPagePercent: Math.min(100, Math.round((bottom - 40 + 12) / 712 * 100)), parseCheck: checkReadingOrder(blocks, extracted) }
  } finally { await pdf.loadingTask.destroy() }
}
export async function renderDocx(blocks: ResumeBlock[]) {
  const fonts = join(dirname(require.resolve('pdfmake/package.json')), 'fonts/Roboto')
  const [regular, bold, italic, boldItalic] = await Promise.all(['Roboto-Regular.ttf', 'Roboto-Medium.ttf', 'Roboto-Italic.ttf', 'Roboto-MediumItalic.ttf'].map((name) => readFile(join(fonts, name))))
  const buffer = await Packer.toBuffer(new Document({
    fonts: [{ name: 'Roboto', data: regular, bold, italic, boldItalic }],
    styles: { default: { document: { run: { font: 'Roboto', size: 20 } } } },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 800, bottom: 800, left: 800, right: 800 } } }, children: blocks.map((block) => new Paragraph({
      children: [new TextRun({ text: block.text, bold: ['name', 'heading', 'section'].includes(block.kind), size: block.kind === 'name' ? 40 : block.kind === 'heading' ? 22 : 20 })],
      bullet: block.kind === 'bullet' ? { level: 0 } : undefined,
      spacing: { before: block.kind === 'heading' ? 200 : 0, after: block.kind === 'bullet' ? 80 : 100, line: 276 },
      keepNext: ['heading', 'section'].includes(block.kind),
    })) }],
  }))
  const extracted = (await mammoth.extractRawText({ buffer })).value
  return { buffer, parseCheck: checkReadingOrder(blocks, extracted) }
}
export function exportBlockers(review: Review): string[] {
  const accepted = review.lines.filter((line) => line.decision === 'accepted')
  const blockers: string[] = []
  if (!accepted.length) blockers.push('Accept at least one résumé line before exporting.')
  for (const line of accepted) if (line.author === 'model' && (line.verdict === 'unsupported' || line.layer1Flags.length > 0 || line.verification !== 'checked')) blockers.push(`Review or remove unsupported model text: ${line.text}`)
  return blockers
}
export function sourceSections(master: Master) {
  return [...master.roles.map((r) => ({ id: r.id, label: `${r.title} · ${r.company}` })), ...master.projects.map((p) => ({ id: p.id, label: `Project · ${p.name}` }))]
}

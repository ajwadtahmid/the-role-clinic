import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'
import { parseHTML } from 'linkedom'
import { Readability } from '@mozilla/readability'

const MAX_BYTES = 3_000_000
const BLOCKED_JOB_SITES = new Set(['linkedin.com', 'indeed.com', 'glassdoor.com'])
interface CapturedJob {
  company: string
  title: string
  location: string
  text: string
  rawSnapshot: string
  url: string
  canonicalUrl?: string
  applyUrl: string
  source: string
  captureMethod: string
}

function publicAddress(address: string) {
  if (address.startsWith('::ffff:')) return publicAddress(address.slice(7))
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113))
  }
  const normalized = address.toLowerCase().split('%')[0]
  return (normalized.startsWith('2') || normalized.startsWith('3')) && !normalized.startsWith('2001:db8')
}

async function fetchPublic(url: URL, redirects = 0): Promise<{ url: URL; body: string; contentType: string }> {
  if (redirects > 4) throw new Error('The job page redirected too many times.')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) throw new Error('Only public HTTP or HTTPS job pages on standard ports can be captured.')
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || BLOCKED_JOB_SITES.has(host) || [...BLOCKED_JOB_SITES].some((domain) => host.endsWith(`.${domain}`))) throw new Error('This job site is not supported for direct capture. Paste the job description instead.')
  const records = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await lookup(host, { all: true, verbatim: true })
  if (!records.length || records.some((record) => !publicAddress(record.address))) throw new Error('The job URL resolves to a private or reserved network address.')
  const selected = records[0]
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  const response = await new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = transport(url, { method: 'GET', headers: { 'user-agent': 'TheRoleClinic/0.1 local job capture', accept: 'text/html,application/json;q=0.9,*/*;q=0.5' }, lookup: (_hostname, lookupOptions, callback) => {
      if (typeof lookupOptions === 'object' && lookupOptions.all) callback(null, [selected])
      else callback(null, selected.address, selected.family)
    }, timeout: 12000 }, (res) => {
      const chunks: Buffer[] = []; let bytes = 0
      res.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) { req.destroy(new Error('Job page response exceeds the 3 MB limit.')); return } chunks.push(chunk) })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('Job page request timed out.')))
    req.on('error', reject)
    req.end()
  })
  const status = response.status
  if ([301, 302, 303, 307, 308].includes(status)) {
    const location = response.headers.location
    if (!location) throw new Error('The job page returned a redirect without a destination.')
    return fetchPublic(new URL(location, url), redirects + 1)
  }
  if (status < 200 || status >= 300) throw new Error(`Job page returned HTTP ${status}.`)
  return { url, body: response.body.toString('utf8'), contentType: String(response.headers['content-type'] ?? '') }
}

const strip = (value: string) => parseHTML(`<html><body>${value}</body></html>`).document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
function jsonLd(html: string): Record<string, unknown> | null {
  const { document } = parseHTML(html)
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')]) {
    try {
      const parsed = JSON.parse(script.textContent ?? '')
      const candidates = Array.isArray(parsed) ? parsed : parsed['@graph'] ?? [parsed]
      const job = candidates.find((item: Record<string, unknown>) => String(item?.['@type'] ?? '').includes('JobPosting'))
      if (job) return job
    } catch { /* try the next JSON-LD block */ }
  }
  return null
}
function companyFromUrl(url: URL) { return url.hostname.replace(/^www\./, '').split('.')[0].replaceAll('-', ' ') }
function supportedAtsUrl(url: URL) {
  return /(?:^|\.)greenhouse\.io$/.test(url.hostname) || url.hostname === 'jobs.lever.co' || url.hostname === 'jobs.ashbyhq.com' || url.hostname === 'jobs.smartrecruiters.com' || /\.myworkdayjobs\.com$/.test(url.hostname)
}
function workdayEndpoint(url: URL) {
  const match = url.pathname.match(/^\/([^/]+)\/job\/(.+)$/)
  if (!match) return null
  const tenant = url.hostname.split('.')[0]
  const path = url.pathname.split('/').filter(Boolean)
  const siteIndex = path.indexOf('job') - 1
  if (siteIndex < 0) return null
  return new URL(`/wday/cxs/${tenant}/${path[siteIndex]}/job/${path.slice(siteIndex + 2).join('/')}`, url.origin)
}

export async function captureJobUrl(input: string, fetcher: typeof fetchPublic = fetchPublic, followDepth = 0): Promise<CapturedJob> {
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Enter a valid job URL.') }
  let endpoint = url
  const parts = url.pathname.split('/').filter(Boolean)
  let parser = 'readability'
  if (/(?:^|\.)greenhouse\.io$/.test(url.hostname) && parts.length >= 3) {
    endpoint = new URL(`/v1/boards/${encodeURIComponent(parts[0])}/jobs/${encodeURIComponent(parts[2])}`, 'https://boards-api.greenhouse.io')
    parser = 'greenhouse-api'
  } else if (url.hostname === 'jobs.lever.co' && parts.length >= 2) {
    endpoint = new URL(`/v0/postings/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`, 'https://api.lever.co')
    parser = 'lever-api'
  } else if (url.hostname === 'jobs.ashbyhq.com' && parts.length >= 2) {
    endpoint = new URL(`/posting-api/job-board/${encodeURIComponent(parts[0])}`, 'https://api.ashbyhq.com')
    parser = 'ashby-api'
  } else if (url.hostname === 'jobs.smartrecruiters.com' && parts.length >= 2) {
    endpoint = new URL(`/v1/companies/${encodeURIComponent(parts[0])}/postings/${encodeURIComponent(parts[1].split('-')[0])}`, 'https://api.smartrecruiters.com')
    parser = 'smartrecruiters-api'
  } else if (/\.myworkdayjobs\.com$/.test(url.hostname)) {
    endpoint = workdayEndpoint(url) ?? url
    parser = endpoint === url ? 'readability' : 'workday-cxs'
  }
  const response = await fetcher(endpoint)
  let data: any = null
  try { data = JSON.parse(response.body) } catch { /* HTML path below */ }
  if (parser !== 'readability' && (data === null || typeof data !== 'object')) throw new Error('This job board did not return the expected data. Paste the job description instead.')
  if (parser === 'ashby-api' && data?.jobs) {
    const match = data.jobs.find((job: any) => job.id === parts[1] || job.jobUrl?.includes(parts[1]))
    if (!match) throw new Error('This Ashby job was not found on its public job board.')
    data = match
  }
  let title = '', company = companyFromUrl(url), description = '', location = '', applyUrl = ''
  if (parser === 'greenhouse-api') { title = data.title ?? ''; company = parts[0].replaceAll('-', ' '); description = strip(data.content ?? ''); location = data.location?.name ?? ''; applyUrl = data.absolute_url ?? '' }
  else if (parser === 'lever-api') { title = data.text ?? ''; company = parts[0].replaceAll('-', ' '); description = [data.description, data.additional].filter(Boolean).map(strip).join('\n\n'); location = data.categories?.location ?? ''; applyUrl = data.applyUrl ?? data.hostedUrl ?? '' }
  else if (parser === 'ashby-api') { title = data.title ?? ''; company = parts[0].replaceAll('-', ' '); description = strip(data.descriptionHtml ?? data.description ?? ''); location = data.location ?? ''; applyUrl = data.applyUrl ?? data.jobUrl ?? '' }
  else if (parser === 'smartrecruiters-api') { title = data.name ?? ''; company = data.company?.name ?? parts[0]; const sections = data.jobAd?.sections ?? []; const rows = Array.isArray(sections) ? sections : Object.values(sections); description = strip(rows.map((section: any) => `${section.title ?? ''} ${section.text ?? ''}`).join('\n')); location = [data.location?.city, data.location?.region, data.location?.country].filter(Boolean).join(', '); applyUrl = data.ref ?? '' }
  else if (parser === 'workday-cxs') { const info = data.jobPostingInfo ?? data; title = info.title ?? ''; company = info.company ?? company; description = strip(info.jobDescription ?? ''); location = info.location ?? ''; applyUrl = info.externalUrl ?? '' }
  else {
    if (followDepth === 0 && response.contentType.includes('html')) {
      const { document } = parseHTML(response.body)
      for (const anchor of [...document.querySelectorAll('a[href]')]) {
        const label = anchor.textContent?.trim() ?? ''
        if (!/apply|continue|company site|view job/i.test(label)) continue
        let linked: URL
        try { linked = new URL(anchor.getAttribute('href') ?? '', response.url) } catch { continue }
        if (!supportedAtsUrl(linked)) continue
        try {
          const followed = await captureJobUrl(linked.toString(), fetcher, 1)
          return { ...followed, url: url.toString(), canonicalUrl: followed.url, applyUrl: followed.applyUrl || followed.url, captureMethod: 'apply-link-follow' }
        } catch { /* Preserve the original page when its apply link is stale. */ }
      }
    }
    const job = jsonLd(response.body)
    if (job) { title = String(job.title ?? ''); company = String((job.hiringOrganization as any)?.name ?? company); description = strip(String(job.description ?? '')); location = String((job.jobLocation as any)?.address?.addressLocality ?? '') }
    if (!description) {
      const parsed = new Readability(parseHTML(response.body).document as unknown as Document).parse()
      description = parsed?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      title ||= parsed?.title ?? ''
    }
  }
  if (description.length < 40) throw new Error('Could not find enough job-description text. Paste the description manually instead.')
  return { company, title, location, text: description.slice(0, 100_000), rawSnapshot: response.body, url: url.toString(), applyUrl, source: parser, captureMethod: parser }
}

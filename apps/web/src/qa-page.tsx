import { AnswerLibrary } from './answers.js'
import { AppHeader, PageHeader } from './layout.js'

// The Question and Answer Bank on its own page: every saved answer, searchable, ready to adapt for another job.
export function QAPage() {
  return <main className="shell" id="main" tabIndex={-1}>
    <AppHeader current="qa" />
    <PageHeader title="Q&A">Questions employers asked and the answers you gave. Answers stay on this device and are never sent to a model.</PageHeader>
    <section className="panel answer-library-panel" aria-labelledby="qa-bank"><h2 id="qa-bank">Question and Answer Bank</h2><AnswerLibrary /></section>
  </main>
}

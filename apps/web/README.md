# Browser UI

The Vite and React UI provides the Jobs screen, job capture, application tracker,
per-job Q&A, model settings, master and profile editing, and a saved résumé review
workspace with interactive and PDF previews and DOCX/PDF exports. The release launcher
opens it in the user's existing browser.

The hash routes `#tracker`, `#gaps`, `#resume` (master résumé), `#resume/profile`, `#settings` and
`#jobs/<id>` (and the older `#job/<id>`, `#master`, `#profile`) open the tracker table (`#tracker?job=<id>` opens a job's questions and answers, `#answers` the answer library inside it), recorded evidence-gap trends, master
résumé editor, profile, settings and the linked job workspace. The job answer editor is
shared by the tailoring drawer and the answer library.

A first-run introduction is shown once and remembered. Settings shows the version, data
folder, database backup downloads and a confirmed stop control. The Linux user guide is
generated from `packaging/USER-GUIDE.md` and shipped as a static `/guide.html`, with no
remote assets or model calls.

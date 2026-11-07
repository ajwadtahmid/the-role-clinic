# Browser UI

The Vite and React UI provides the local Inbox, job capture, application tracker,
per-job Q&A, model settings, master/profile editing, and a saved résumé review
workspace with interactive/PDF previews and DOCX/PDF exports. The release launcher will open it in the user's
existing browser.

The hash routes `#tracker`, `#gaps`, `#answers` and `#job/<id>` open the tracker
table, recorded evidence-gap trends, answer library and linked job workspace.
The job answer editor is shared with the tailoring drawer and answer library.

Phase 7 wraps the app in a persisted first-run introduction and adds version,
data-folder, backup-download and confirmed-stop controls to Settings. The Linux
user guide is generated locally from `packaging/USER-GUIDE.md` and shipped as a
static `/guide.html`, with no remote guide assets or model calls.

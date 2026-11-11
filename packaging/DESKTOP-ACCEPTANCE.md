# Desktop acceptance record

Use a clean native system for each advertised OS/CPU, without Node/npm/Rust/SQLite
or developer tools. Record date, OS/CPU, package SHA-256, app version, signing status,
webview version and screenshots. Use synthetic records and controlled model responses.
A build or backend-only pass does not complete this checklist.

| Check | Linux x64 | macOS arm64 (no build yet) | Windows x64 |
| --- | --- | --- | --- |
| Download, checksum, normal double-click/install; no terminal needed | Pending owner acceptance | Pending | Pending |
| Missing WebView2/GTK/FUSE handling matches instructions | Pending clean machine | System WKWebView | Pending clean machine |
| Trusted signature/notarization and normal OS security checks | Pending release channel | Pending | Pending |
| Paste/URL capture, blocked URL paste fallback, tracker statuses/filtering | Automated Linux; owner visual pending | Pending | Pending |
| Master JSON/PDF/DOCX import with actual native Open chooser; master/profile edit | Owner chooser check pending | Pending | Pending |
| Review, source citations, PDF proof/page count and text selection | Automated Linux; owner visual pending | Pending | Pending |
| Native Save/cancel/overwrite for PDF/DOCX/XLSX/CSV, Unicode/long filenames | Automated Linux; owner visual pending | Pending | Pending |
| Answer edit/reuse/copy; native clipboard; posting links in browser | Automated Linux; owner visual pending | Pending | Pending |
| Tab/Shift+Tab, focus, screen reader labels; standard edit shortcuts | Pending owner acceptance | Pending | Pending |
| Quit/close, active-run cancel/confirm, second-launch focus | Automated Linux; owner visual pending | Pending | Pending |
| 100%/150%/200% scaling; resize, long content, multiple screens | Pending owner acceptance | Pending | Pending |
| Controlled Ollama success/unavailable and configuration persistence; no paid calls | Backend smoke | Pending native CI/UI | Pending native CI/UI |
| Restart/crash/interrupted-run recovery; single writer with browser fallback | Automated Linux | Pending native CI/UI | Pending native CI/UI |
| Install replacement/update preserves jobs, submitted files, settings and backups | Pending installed update | Pending | Pending |
| Full backup, restore preview/confirm, recovery folder and cross-OS artifact relocation | Linux backend tests | Pending native restore | Pending native restore |
| Older schema migration snapshot; newer schema refusal leaves database untouched | Linux backend tests | Pending native CI | Pending native CI |
| Uninstall leaves seeded user data; reinstall reopens it; optional data removal documented | Pending installed uninstall | Pending | Pending |

For update/uninstall tests, seed an isolated workspace and keep its manifest/hashes
outside the installation folder. Check database records, export bytes and settings
before/after actual installer replacement and removal. Do not use a personal résumé
or real API key. Run the older app only on compatible data or a restored backup.

Do not mark an entire platform supported until native interaction and clean-install
checks pass and any exceptions are recorded. Intel Mac, Linux ARM and Windows ARM
remain outside the initial target set.

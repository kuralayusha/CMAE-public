# CMAE — Cold Mail AI Engine

Local-first cold mail agent.

## Active surfaces

- **Tracker** (`/` → `/tracker`) — Gmail sync (last 30 days) + search outputs; application status list; Gmail Drafts (you send)
- **Search** (`/search`) — URL list → parallel agents + live terminals → `workspace/`
- **Folders** (`/folders`) — workspace file browser
- **Settings** (`/settings`) — profile, CVs, Gmail App Password, Cursor API key, follow-up days, preferred language

## Tracker statuses (priority order)

1. Ready to send (`ready_to_send`)
2. Reply needed (`needs_reply`, positive → negative)
3. Follow-up due (`follow_up_due`, max 2)
4. Active conversations (`in_progress`)
5. Rejected (`rejected`)
6. Closed (`closed`)
7. Ignored (`ignored`, after 2 follow-ups)

Sync: **Gmail sync** = incremental (UID cursor); **Hard Sync** = re-fetch last 30 days. Both upsert by `messageId` — mail outside the window is not deleted, no duplicates. Search `done` → light merge (no IMAP/AI). Set `CMAE_DISABLE_SYNC=1` to disable IMAP.

## Search architecture

**Conductor** + specialist agents (parallel URLs, each URL has its own conductor):

`scout → jobfit → contact → research → writer → reviewer`

Reviewer scores (threshold ~72). If it dislikes the pack it rewinds to `rewindTo` and re-runs from that step through writer, then reviews again.

Terminals: lines tagged `[scout]`, `[writer]`, `[reviewer]`, …

## Run

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

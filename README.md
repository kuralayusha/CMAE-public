# CMAE — Cold Mail AI Engine

Local-first cold mail ajanı.

## Aktif

- **Tracker** (`/` → `/tracker`) — Gmail sync (son 30 gün) + search çıktıları; başvuru durum listesi; Gmail Drafts taslağı (gönderim kullanıcıda)
- **Search** (`/search`) — link listesi → paralel agent + canlı terminaller → `workspace/`
- **Folders** (`/folders`) — workspace gezgini
- **Ayarlar** (`/settings`) — profil, CV, Gmail App Password, Cursor API key, follow-up günü, tercih dili

## Tracker durumları (öncelik sırası)

1. Gönderilmeyi bekleyenler (`ready_to_send`)
2. Cevap geldi — bizden aksiyon (`needs_reply`, olumlu → olumsuz)
3. Follow-up gerekli (`follow_up_due`, max 2)
4. Aktif görüşmeler (`in_progress`)
5. Reddedilenler (`rejected`)
6. Kapanmış (`closed`)
7. Kara liste (`ignored`, 2 follow-up sonrası)

Sync: **Gmail sync** = incremental (UID cursor); **Hard Sync** = son 30 günü yeniden çeker. İkisi de `messageId` upsert eder — pencere dışı mailler silinmez, duplicate olmaz. Search `done` → light merge (IMAP/AI yok). `CMAE_DISABLE_SYNC=1` ile IMAP kapatılabilir.

## Search mimarisi

**Conductor** + uzman ajanlar (paralel URL’ler, her URL kendi conductor’ı):

`scout → jobfit → contact → research → writer → reviewer`

Reviewer skorlar (eşik ~72). Beğenmezse `rewindTo` ajanına geri sarar; o adımdan writer’a kadar yeniden koşar, tekrar review.

Terminaller: `[scout]`, `[writer]`, `[reviewer]`… etiketli satırlar.

## Çalıştırma

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

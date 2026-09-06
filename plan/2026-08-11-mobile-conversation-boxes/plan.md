# Implementation Plan

## Minimal Diff

### 1. Backend conversation summary endpoint
File: `apps/gateway-api/src/modules/messages.ts`

Add:
- `GET /api/v1/messages/conversations`

SQL shape:
```sql
WITH ranked AS (
  SELECT *, row_number() OVER (PARTITION BY remote_jid ORDER BY COALESCE(received_at,sent_at,created_at) DESC) rn
  FROM whatsapp_messages
  WHERE ...filters...
)
SELECT
  r.remote_jid,
  cm.candidate_name,
  cm.recruitment_stage,
  cm.form_submitted,
  r.text_body AS last_text,
  r.direction AS last_direction,
  r.message_type AS last_message_type,
  r.status,
  r.processing_state,
  COALESCE(r.received_at,r.sent_at,r.created_at) AS last_at,
  counts.total_messages,
  counts.failed_messages
FROM ranked r
JOIN (...) counts USING(remote_jid)
LEFT JOIN contact_memory cm USING(remote_jid)
WHERE r.rn=1
ORDER BY last_at DESC
LIMIT/OFFSET;
```

Use existing `/api/v1/messages?jid=<remote_jid>&limit=100` for detail first. No new detail endpoint needed.

### 2. Frontend split state
File: `apps/dashboard/src/components/features/messages-center.tsx`

Add state:
- `selectedJid`
- `viewMode`: default `conversations`; optional `messages` debug view.

Fetch:
- Conversation list: `/api/gateway/messages/conversations?...`
- Selected history: `/api/gateway/messages?jid=${selectedJid}&limit=100&page=1`

### 3. Mobile-first card UI
Replace default table section with:
- Filter panel: grid/flex wrap, each input `w-full sm:w-*`.
- Conversation cards:
  - `remote_jid` / candidate name
  - latest text preview
  - last time
  - status badge
  - counts
- Detail:
  - mobile: below list after card selected
  - desktop: `lg:grid-cols-[360px_1fr]`

### 4. Bubble history
Render selected messages chronological ascending:
- inbound: left, muted background
- outbound: right, primary/light background
- include timestamp + status small text
- failed messages show retry button

### 5. Verification
- `npm run typecheck --workspace=@ocgw/gateway-api`
- `npm run typecheck --workspace=@ocgw/dashboard`
- `npm run build --workspace=@ocgw/gateway-api`
- `npm run build --workspace=@ocgw/dashboard`
- mobile screenshot at 390px width if browser available

## Recommendation
Implement this next. No schema change first. If API slow after real data, add index on `(remote_jid, COALESCE(...))` via migration.

# Evaluation

## Findings

### Current frontend
File: `apps/dashboard/src/components/features/messages-center.tsx`

- Uses `<table className="data-table min-w-[820px]">` inside `overflow-x-auto`.
- Each row = one WhatsApp message.
- Filters are packed into one flex row on large screens, but mobile still gets crowded.
- Detail action opens a modal for exactly one message.
- Reading a full candidate history requires scanning many separate rows and opening details repeatedly.

### Current backend
File: `apps/gateway-api/src/modules/messages.ts`

- `GET /api/v1/messages` supports filters: page, limit, direction, status, jid, from, to, search.
- Query returns individual `whatsapp_messages` rows ordered by latest event time.
- `GET /api/v1/messages/:id` returns one message detail.
- No conversation/grouped endpoint yet.

## UX Problem
For HRD operations, the primary unit is not a message; it is a candidate/contact. Current page optimizes for queue debugging, not reading applicant conversations.

## Recommendation
Keep technical row view as secondary/debug mode. Make default view conversation-centric:

1. Conversation list/card mode
   - One card per `remote_jid`.
   - Last message preview.
   - Last activity time.
   - Status summary: latest status + failed count/responded marker.
   - Candidate name from `contact_memory` when available.

2. Conversation detail panel
   - Click card opens full history for that `remote_jid`.
   - Mobile: full-width sheet/dialog or navigated section.
   - Desktop: two-column layout, list left, history right.
   - Bubble layout: inbound left, outbound right.

3. API support
   - Add `GET /api/v1/conversations` or `GET /api/v1/messages/conversations`.
   - Add `GET /api/v1/conversations/:jid/messages` or reuse `/api/v1/messages?jid=<jid>&limit=100`.
   - Prefer no DB migration: derive via SQL grouping over `whatsapp_messages`, left join `contact_memory`.

## Risks
- Grouping SQL must not become slow. Add index only if current indexes insufficient.
- JID in URL needs safe encoding.
- Search semantics: search should match number, candidate name, last summary, message text.
- Existing retry action is per-message, so failed-message actions need remain visible in detail view.

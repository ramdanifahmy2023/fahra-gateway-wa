# Blueprint — WA Baileys reply failures audit

## Objective
Audit why many incoming WhatsApp/Baileys messages fail to receive replies. Produce structured Plan/Build/Exec/Maintainer documentation and connect durable findings to MEMORY.md and TOOLS.md.

## Scope
- Inspect gateway logs, bridge worker, Baileys service, queue/job storage, dashboard/manual-mode state.
- Redact secrets and message/customer PII.
- Prefer minimal fixes; no restart or outbound replay without explicit confirmation.

## Deliverables
- `plan.md` / `blueprint.md`
- `execution-log.md`
- `evaluation.md`
- `maintenance.md`
- `audit.md`
- MEMORY.md + TOOLS.md updates

## Safety
- No token/AuthState/QR/phone/customer body exposure.
- No mass replay.
- No destructive data edits.

# Update Plan

## Phase 1 — Global modal mobile fix
1. Patch `apps/dashboard/src/components/ui/dialog.tsx`.
2. Mobile bottom sheet; desktop centered.
3. Header close spacing.
4. Typecheck dashboard.

## Phase 2 — Form footer fixes
1. Patch `resource-manager.tsx` footer buttons responsive.
2. Patch `contact-memory-center.tsx` submit button full width mobile.
3. Patch messages detail JSON/pre overflow.

## Phase 3 — Verify
1. `npm run typecheck --workspace=@ocgw/dashboard`
2. `npm run build --workspace=@ocgw/dashboard`
3. Browser screenshot mobile if login available.
4. Restart only after pass.

## Recommendation
Do Phase 1 + Phase 2 together. Small diff, fixes every popup class at once.

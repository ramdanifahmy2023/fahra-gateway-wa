# Maintenance

## Monitoring
- After implementation, test on desktop and mobile viewport.
- Check slow query logs or API latency for conversations endpoint.
- Verify failed outbound retry remains reachable.

## Future Improvements
- Add unread/new inbound indicator.
- Add candidate stage badges from `contact_memory`.
- Add quick reply box inside conversation detail.
- Add owner notification link to open conversation directly.

## Rollback
- Keep old table view behind toggle or secondary tab.
- If conversation API breaks, default back to `/api/v1/messages` individual rows.

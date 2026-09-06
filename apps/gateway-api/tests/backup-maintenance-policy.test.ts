import { describe, expect, it } from "vitest";
import {
  WEEKLY_BACKUP_RETAIN,
  WEEKLY_BACKUP_SCHEDULING_STATUSES,
  localBackupWindow,
  weeklyBackupDedupeKey,
  weeklyRetentionIds,
} from "../src/backup-maintenance-policy.js";

describe("weekly backup policy", () => {
  it("uses the application timezone and opens at 02:00 local time", () => {
    expect(
      localBackupWindow("Asia/Jakarta", new Date("2026-08-09T18:59:59Z")),
    ).toEqual({
      scheduledDate: "2026-08-10",
      scheduledWeek: "2026-W33",
      eligible: false,
    });
    expect(
      localBackupWindow("Asia/Jakarta", new Date("2026-08-09T19:00:00Z")),
    ).toEqual({
      scheduledDate: "2026-08-10",
      scheduledWeek: "2026-W33",
      eligible: true,
    });
  });

  it("retains exactly seven newest automated backups", () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ id: `b${index}` }));
    expect(WEEKLY_BACKUP_RETAIN).toBe(7);
    expect([...weeklyRetentionIds(rows)]).toEqual(["b7", "b8", "b9"]);
  });

  it("only active or completed operations block another weekly schedule", () => {
    expect([...WEEKLY_BACKUP_SCHEDULING_STATUSES]).toEqual([
      "queued",
      "running",
      "completed",
    ]);
    expect(WEEKLY_BACKUP_SCHEDULING_STATUSES).not.toContain("failed");
    expect(WEEKLY_BACKUP_SCHEDULING_STATUSES).not.toContain("cancelled");
  });

  it("deduplicates per week and operation instead of reusing terminal history", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(weeklyBackupDedupeKey("2026-W33", first)).toBe(
      `backup-weekly:2026-W33:${first}`,
    );
    expect(weeklyBackupDedupeKey("2026-W33", first)).not.toBe(
      weeklyBackupDedupeKey("2026-W33", second),
    );
  });
});

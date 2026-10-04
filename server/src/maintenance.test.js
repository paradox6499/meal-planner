import { describe, it, expect } from "vitest";
import { openDb, insertEvent, summarizeEventsSince, upsertIngredientPrices, getIngredientPricesByName } from "./db.js";
import { runMaintenance, EVENTS_RETENTION_DAYS, PRICES_RETENTION_DAYS } from "./maintenance.js";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("runMaintenance", () => {
  it("удаляет события старше срока хранения, свежие оставляет", () => {
    const db = openDb(":memory:");
    insertEvent(db, { telegramUserId: 1, eventName: "old", props: null, createdAtISO: daysAgo(EVENTS_RETENTION_DAYS + 1) });
    insertEvent(db, { telegramUserId: 1, eventName: "fresh", props: null, createdAtISO: daysAgo(EVENTS_RETENTION_DAYS - 1) });
    const result = runMaintenance(db, NOW);
    expect(result.eventsDeleted).toBe(1);
    expect(summarizeEventsSince(db, "2000-01-01T00:00:00Z").byName.map((r) => r.event_name)).toEqual(["fresh"]);
  });

  it("удаляет устаревший кэш цен, свежий оставляет", () => {
    const db = openDb(":memory:");
    upsertIngredientPrices(db, [{ name: "Старый", matched: false }], daysAgo(PRICES_RETENTION_DAYS + 1));
    upsertIngredientPrices(db, [{ name: "Свежий", matched: true, price: 10, productUnit: "кг", xmlId: "1" }], daysAgo(1));
    expect(runMaintenance(db, NOW).pricesDeleted).toBe(1);
    expect([...getIngredientPricesByName(db, ["Старый", "Свежий"]).keys()]).toEqual(["Свежий"]);
  });

  it("на пустой базе ничего не ломает", () => {
    expect(runMaintenance(openDb(":memory:"), NOW)).toEqual({ eventsDeleted: 0, pricesDeleted: 0, deletedAccountsPurged: 0 });
  });
});

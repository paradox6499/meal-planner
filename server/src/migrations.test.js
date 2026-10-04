import { describe, it, expect, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, runMigrations, getSchemaVersion, MIGRATIONS, SCHEMA_VERSION, countPlanGenerationsSince } from "./db.js";

let dir;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = null; });
const tmpPath = () => { dir = mkdtempSync(join(tmpdir(), "mig-")); return join(dir, "t.db"); };
const columns = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

// База «как на проде до версионирования»: самая первая форма таблиц, без колонок,
// которые добавлялись позже, user_version = 0, внутри живые данные.
function makeLegacyDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE users (telegram_user_id INTEGER PRIMARY KEY, timezone_offset_minutes INTEGER NOT NULL DEFAULT 180, reminder_lead_minutes INTEGER NOT NULL DEFAULT 30);
    CREATE TABLE ingredient_prices (name TEXT PRIMARY KEY, matched INTEGER NOT NULL, price REAL, product_unit TEXT, xml_id TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE payments (id INTEGER PRIMARY KEY AUTOINCREMENT, yookassa_payment_id TEXT NOT NULL UNIQUE, telegram_user_id INTEGER NOT NULL, amount_rub REAL NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT);
    CREATE TABLE referrals (id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_telegram_id INTEGER NOT NULL, referred_telegram_id INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL, rewarded_at TEXT);
    CREATE TABLE families (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_telegram_id INTEGER NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users (telegram_user_id) VALUES (1), (2);
    INSERT INTO ingredient_prices VALUES ('лук', 1, 54, 'кг', '605', '2026-10-01T00:00:00.000Z');
    INSERT INTO payments (yookassa_payment_id, telegram_user_id, amount_rub, status, created_at) VALUES ('p1', 1, 299, 'succeeded', '2026-09-20T00:00:00.000Z');
    INSERT INTO referrals (referrer_telegram_id, referred_telegram_id, created_at, rewarded_at) VALUES (1, 10, '2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z'), (1, 11, '2026-09-03T00:00:00.000Z', NULL);
    INSERT INTO families (owner_telegram_id, created_at) VALUES (1, '2026-09-10T00:00:00.000Z'), (2, '2026-09-11T00:00:00.000Z');
  `);
  return db;
}

describe("версионирование схемы", () => {
  it("новая база получает последнюю версию схемы", () => {
    const db = openDb(":memory:");
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.at(-1).version);
  });

  it("версии миграций идут подряд с 1 — без дыр и повторов", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it("старая база без версии: данные целы, колонки добавлены, бэкфилл выполнен, версия проставлена", () => {
    const path = tmpPath();
    const legacy = makeLegacyDb(path);
    expect(getSchemaVersion(legacy)).toBe(0);
    legacy.close();

    const db = openDb(path);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);

    // данные на месте
    expect(db.prepare("SELECT COUNT(*) c FROM users").get().c).toBe(2);
    expect(db.prepare("SELECT price FROM ingredient_prices WHERE name = 'лук'").get().price).toBe(54);
    expect(db.prepare("SELECT status, product FROM payments WHERE yookassa_payment_id = 'p1'").get()).toMatchObject({ status: "succeeded", product: "pro" });

    // колонки, которых в старой схеме не было
    expect(columns(db, "users")).toEqual(expect.arrayContaining(["is_pro", "pro_until", "renewal_reminder_sent_at", "extra_plan_credits", "free_nudge_sent_at", "referral_rewards_total"]));
    expect(columns(db, "ingredient_prices")).toEqual(expect.arrayContaining(["package_amount", "package_unit"]));
    expect(columns(db, "families")).toContain("invite_code");

    // бэкфилл: у каждой старой семьи появился уникальный код, у пригласившего — счётчик наград
    const codes = db.prepare("SELECT invite_code FROM families").all().map((r) => r.invite_code);
    expect(codes.every((c) => typeof c === "string" && c.length >= 12)).toBe(true);
    expect(new Set(codes).size).toBe(2);
    expect(db.prepare("SELECT referral_rewards_total t FROM users WHERE telegram_user_id = 1").get().t).toBe(1);

    // и новые таблицы создались
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["deleted_accounts", "warm_targets", "events", "plan_history"]));
    db.close();
  });

  it("миграция 3 переносит сборки из событий в журнал с теми же датами и источниками — лимит не меняется", () => {
    const path = tmpPath();
    // база версии 2: уже есть events, журнала ещё нет
    const old = new DatabaseSync(path);
    runMigrations(old, MIGRATIONS.slice(0, 2));
    old.exec(`
      INSERT INTO events (telegram_user_id, event_name, props_json, created_at) VALUES
        (7, 'plan_generated', NULL, '2026-10-01T10:00:00.000Z'),
        (7, 'plan_generated_credit', NULL, '2026-10-02T10:00:00.000Z'),
        (7, 'plan_generated_pro', NULL, '2026-10-03T10:00:00.000Z'),
        (7, 'app_opened', NULL, '2026-10-03T11:00:00.000Z'),
        (NULL, 'plan_generated', NULL, '2026-10-03T12:00:00.000Z');
    `);
    expect(getSchemaVersion(old)).toBe(2);
    old.close();

    const db = openDb(path);
    expect(getSchemaVersion(db)).toBe(SCHEMA_VERSION);
    const rows = db.prepare("SELECT telegram_user_id, source, created_at FROM plan_generations ORDER BY created_at").all();
    expect(rows.map((r) => [r.telegram_user_id, r.source, r.created_at])).toEqual([
      [7, "free", "2026-10-01T10:00:00.000Z"],
      [7, "credit", "2026-10-02T10:00:00.000Z"],
      [7, "pro", "2026-10-03T10:00:00.000Z"],
    ]);
    // бесплатный лимит считается по журналу так же, как раньше по событиям
    expect(countPlanGenerationsSince(db, 7, "2026-09-30T00:00:00.000Z")).toBe(1);
    db.close();
  });

  it("повторное открытие ничего не меняет: версия та же, коды семей прежние", () => {
    const path = tmpPath();
    makeLegacyDb(path).close();
    const first = openDb(path);
    const codes = first.prepare("SELECT invite_code FROM families ORDER BY id").all().map((r) => r.invite_code);
    first.close();
    const second = openDb(path);
    expect(getSchemaVersion(second)).toBe(SCHEMA_VERSION);
    expect(second.prepare("SELECT invite_code FROM families ORDER BY id").all().map((r) => r.invite_code)).toEqual(codes);
    second.close();
  });

  it("база новее кода: сервер не стартует и называет причину", () => {
    const path = tmpPath();
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 5}`);
    db.close();
    expect(() => openDb(path)).toThrow(/новее/);
  });

  it("упавшая миграция откатывается целиком и версия не растёт", () => {
    const db = new DatabaseSync(":memory:");
    const migrations = [
      { version: 1, name: "ok", up: (d) => d.exec("CREATE TABLE a (x INTEGER)") },
      { version: 2, name: "bad", up: (d) => { d.exec("CREATE TABLE b (x INTEGER)"); d.exec("CREATE TABLE a (x INTEGER)"); /* уже есть — ошибка */ } },
    ];
    expect(() => runMigrations(db, migrations)).toThrow(/Миграция 2 \(bad\) не применилась/);
    expect(getSchemaVersion(db)).toBe(1); // первая применилась, вторая — нет
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
    expect(tables).toContain("a");
    expect(tables).not.toContain("b"); // половина второй миграции откатилась
  });

  it("применяются только недостающие миграции, по порядку", () => {
    const db = new DatabaseSync(":memory:");
    const order = [];
    const migrations = [1, 2, 3].map((v) => ({ version: v, name: `m${v}`, up: () => order.push(v) }));
    expect(runMigrations(db, migrations.slice(0, 2))).toEqual([1, 2]);
    expect(runMigrations(db, migrations)).toEqual([3]);
    expect(runMigrations(db, migrations)).toEqual([]);
    expect(order).toEqual([1, 2, 3]);
  });
});

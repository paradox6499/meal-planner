import { describe, it, expect, vi } from "vitest";
import { isRelevantProduct, pickRelevantProduct, fallbackQueries, findProductFor } from "./productMatch.js";

const combo = { id: 1, name: 'Комбо-набор: Котлета куриная с картофельным пюре и Салат "Витаминный"' };
const onion = { id: 2, name: "Лук репчатый, 1 кг" };

describe("productMatch", () => {
  it("комбо-набор не подходит под «Лук перо», лук — подходит", () => {
    expect(isRelevantProduct("Лук перо", combo)).toBe(false);
    expect(isRelevantProduct("Лук перо", onion)).toBe(true);
  });

  it("совпадает по началу слова: падежи и ё/е не мешают", () => {
    expect(isRelevantProduct("Морковь", { name: "Моркови мытой 1 кг" })).toBe(true);
    expect(isRelevantProduct("Яйцо куриное", { name: "Яйца куриные С1, 10 шт" })).toBe(true);
    expect(isRelevantProduct("Огурец", { name: "Огурцы гладкие" })).toBe(true);
    expect(isRelevantProduct("Гречка", { name: "Крупа гречневая" })).toBe(true);
    expect(isRelevantProduct("Крупа гречневая", { name: "Крупа гречневая ядрица" })).toBe(true);
    expect(isRelevantProduct("Зелёный горошек", { name: "Горошек зеленый" })).toBe(true);
  });

  it("«перо» не совпадает с «перепелиные», «свежий» — не повод выбрать «Сыр свежий»", () => {
    expect(isRelevantProduct("Лук перо", { name: "Яйца перепелиные копченые" })).toBe(false);
    expect(isRelevantProduct("Огурец свежий", { name: 'Сыр мягкий "Свежий для салатов"' })).toBe(false);
  });

  it("берёт первый подходящий из выдачи, а не первый вообще", () => {
    expect(pickRelevantProduct("Лук перо", [combo, onion])).toBe(onion);
    expect(pickRelevantProduct("Лук перо", [combo])).toBeNull();
  });

  it("переискивает по отдельным словам только у составных названий", () => {
    expect(fallbackQueries("Лук перо")).toEqual(["лук", "перо"]);
    expect(fallbackQueries("Сметана")).toEqual([]);
  });

  it("findProductFor: полная выдача без лука -> второй запрос по слову «лук»", async () => {
    const search = vi.fn(async (q) => (q === "Лук перо" ? { items: [combo] } : { items: [onion] }));
    expect(await findProductFor("Лук перо", search)).toBe(onion);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it("findProductFor: подходящий уже в первой выдаче — лишних запросов нет", async () => {
    const search = vi.fn(async () => ({ items: [combo, onion] }));
    expect(await findProductFor("Лук перо", search)).toBe(onion);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("findProductFor: нигде нет подходящего — прежнее поведение, первый товар; пустая выдача — null", async () => {
    expect(await findProductFor("Лук перо", async () => ({ items: [combo] }))).toBe(combo);
    expect(await findProductFor("Что-то", async () => ({ items: [] }))).toBeNull();
  });
});

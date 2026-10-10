import { describe, it, expect } from "vitest";
import { ACQUISITION_OPTIONS, startParamKind } from "./acquisition.js";

describe("acquisition", () => {
  it("у каждого варианта своё событие с префиксом acq_, имена не повторяются", () => {
    expect(new Set(ACQUISITION_OPTIONS.map((o) => o.event)).size).toBe(ACQUISITION_OPTIONS.length);
    for (const o of ACQUISITION_OPTIONS) expect(o.event).toMatch(/^acq_[a-z]+$/);
  });

  it("startParamKind отдаёт только тип ссылки и никогда не сам код", () => {
    expect(startParamKind(undefined)).toBe("none");
    expect(startParamKind("")).toBe("none");
    expect(startParamKind("ref_123456")).toBe("ref");
    expect(startParamKind("fam_AbCdEf")).toBe("fam");
    expect(startParamKind("promo_channel")).toBe("other");
  });
});

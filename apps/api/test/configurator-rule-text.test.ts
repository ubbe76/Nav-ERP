import { describe, expect, it } from "vitest";
import { conditionsText, ruleText } from "../../web/components/configurator/ruleText";

const groups = [
  { id: "g1", code: "FARG", name: "Ytbehandling", kind: "choice", values: [{ id: "v1", code: "EP", name: "Elpolerad" }, { id: "v3", code: "BL", name: "Blästrad" }] },
  { id: "g2", code: "LOCK", name: "Lock", kind: "choice", values: [{ id: "v2", code: "C", name: "C" }] },
  { id: "g3", code: "BREDD", name: "Bredd", kind: "number", unit: "mm", values: [] },
  { id: "g4", code: "HJUL", name: "Hjul", kind: "boolean", values: [] },
  { id: "g5", code: "UNDER", name: "Underrede", kind: "boolean", values: [] },
] as never;

describe("ruleText", () => {
  it("reads like the UI", () => {
    expect(ruleText({ effect: "exclude", conditions: [{ groupId: "g1", op: "is", valueIds: ["v1"] }], target: { groupId: "g2", valueIds: ["v2"] } } as never, groups))
      .toBe("Om Ytbehandling är Elpolerad → utesluter Lock: C");
    expect(ruleText({ effect: "require", conditions: [{ groupId: "g4", op: "selected" }], target: { groupId: "g5", op: "selected" } } as never, groups))
      .toBe("Om Hjul är vald → kräver Underrede är vald");
    expect(ruleText({ effect: "limit", conditions: [{ groupId: "g1", op: "is", valueIds: ["v1"] }], target: { groupId: "g3", max: 2400 } } as never, groups))
      .toBe("Om Ytbehandling är Elpolerad → begränsar Bredd till högst 2400 mm");
    expect(ruleText({ effect: "require", conditions: [], target: { groupId: "g5", op: "selected" } } as never, groups))
      .toBe("Alltid → kräver Underrede är vald");
    expect(ruleText({ effect: "limit", conditions: [{ groupId: "g3", op: "gt", value: 2000 }, { groupId: "g4", op: "selected" }], target: { groupId: "g3", min: 900, max: 2400 } } as never, groups))
      .toBe("Om Bredd > 2000 mm och Hjul är vald → begränsar Bredd till 900–2400 mm");
  });

  it("joins alternatives with eller and marks missing references", () => {
    expect(ruleText({ effect: "exclude", conditions: [{ groupId: "g1", op: "is_not", valueIds: ["v1", "v3"] }], target: { groupId: "g2", valueIds: ["v2"] } } as never, groups))
      .toBe("Om Ytbehandling är inte Elpolerad eller Blästrad → utesluter Lock: C");
    expect(ruleText({ effect: "exclude", conditions: [{ groupId: "gX", op: "is", valueIds: ["vX"] }], target: { groupId: "g2", valueIds: ["vY"] } } as never, groups))
      .toBe("Om (borttagen) är (borttagen) → utesluter Lock: (borttagen)");
    expect(ruleText({ effect: "limit", conditions: [], target: { groupId: "g3", min: 900 } } as never, groups))
      .toBe("Alltid → begränsar Bredd till minst 900 mm");
  });
});

describe("conditionsText", () => {
  it("joins with och and says Alltid when empty", () => {
    expect(conditionsText([], groups)).toBe("Alltid");
    expect(conditionsText([{ groupId: "g3", op: "gt", value: 2000 }, { groupId: "g4", op: "selected" }] as never, groups))
      .toBe("Om Bredd > 2000 mm och Hjul är vald");
  });
});

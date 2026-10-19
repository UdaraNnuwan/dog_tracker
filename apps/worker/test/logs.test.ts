import { describe, expect, it } from "vitest";
import { levelsFrom, likeEscape, parseLogsQuery } from "../src/storage/logs.js";

describe("parseLogsQuery", () => {
  it("defaults to the newest 200 lines with no filters", () => {
    expect(parseLogsQuery({})).toEqual({
      from: null,
      to: null,
      deviceId: null,
      topic: null,
      minLevel: null,
      source: null,
      search: null,
      beforeId: null,
      afterId: null,
      limit: 200,
    });
  });

  it("parses every filter", () => {
    expect(
      parseLogsQuery({
        from: "2026-10-19T00:00:00Z",
        to: "2026-10-19T01:00:00Z",
        device: "demo01",
        topic: "telemetry/gps",
        level: "warn",
        source: "ingest",
        q: "  rejected ",
        before: "500",
        limit: "50",
      }),
    ).toMatchObject({
      from: "2026-10-19T00:00:00.000Z",
      to: "2026-10-19T01:00:00.000Z",
      deviceId: "demo01",
      topic: "telemetry/gps",
      minLevel: "warn",
      source: "ingest",
      search: "rejected",
      beforeId: 500,
      limit: 50,
    });
  });

  it.each([
    [{ from: "nope" }, /ISO/],
    [{ from: "2026-10-19T02:00:00Z", to: "2026-10-19T01:00:00Z" }, /before/],
    [{ device: "Bad Id" }, /device/],
    [{ topic: "a b" }, /topic/],
    [{ level: "debug" }, /level/],
    [{ source: "x" }, /source/],
    [{ before: "-1" }, /positive/],
    [{ limit: "5000" }, /limit/],
  ])("rejects %o", (params, message) => {
    expect(parseLogsQuery(params)).toMatch(message);
  });
});

describe("helpers", () => {
  it("levelsFrom returns the level and everything above it", () => {
    expect(levelsFrom("warn")).toEqual(["warn", "error"]);
  });

  it("likeEscape neutralises wildcards", () => {
    expect(likeEscape("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

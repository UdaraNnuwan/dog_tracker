import { parseInbound } from "@udara/contracts";
import { describe, expect, it } from "vitest";
import { IngestStats } from "../src/bridge/ingestStats.js";

const gps = JSON.stringify({ timestamp: 1717330000, latitude: 6.9, longitude: 79.8, speed: 0 });

function record(stats: IngestStats, topic: string, body: string) {
  stats.record(topic, parseInbound(topic, body));
}

describe("IngestStats", () => {
  it("returns null when nothing arrived", () => {
    expect(new IngestStats().flush()).toBeNull();
  });

  it("counts accepted messages by path and rejections by reason, then resets", () => {
    const stats = new IngestStats();
    record(stats, "pettracker/dog001/backend/telemetry/gps", gps);
    record(stats, "pettracker/dog002/backend/telemetry/gps", gps);
    record(
      stats,
      "pettracker/dog001/backend/settings/response/gps_settings",
      '{"timestamp":1,"action":"get_response","setting_id":"s","setting_type":"gps","gps_interval":45}',
    );
    record(stats, "pettracker/dog001/backend/telemetry/gps", "{oops");
    record(stats, "pettracker/dog001/backend/nope", gps);

    expect(stats.flush()).toEqual({
      accepted: { "telemetry/gps": 2, "settings/response": 1 },
      rejected: { invalid_json: 1, unknown_topic: 1 },
      samples: [
        {
          topic: "pettracker/dog001/backend/telemetry/gps",
          reason: "invalid_json",
          issues: [expect.any(String)],
        },
        { topic: "pettracker/dog001/backend/nope", reason: "unknown_topic", issues: [] },
      ],
    });
    expect(stats.flush()).toBeNull();
  });

  it("caps rejection samples per tick", () => {
    const stats = new IngestStats();
    for (let i = 0; i < 10; i++) record(stats, "pettracker/dog001/backend/telemetry/gps", "x");
    const summary = stats.flush();
    expect(summary?.rejected).toEqual({ invalid_json: 10 });
    expect(summary?.samples).toHaveLength(3);
  });
});

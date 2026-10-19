import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BRIDGE_ID } from "../src/bridge/MqttBridge.js";

function stub() {
  return env.MQTT_BRIDGE.get(env.MQTT_BRIDGE.idFromName(BRIDGE_ID));
}

/**
 * Awaits the RPC call directly: handing the RPC promise to `expect().rejects` leaves its
 * pipelined twin unhandled. (The pool's DO wrapper still logs "uncaught exception"
 * lines for these rejections; that is harness noise and does not fail the run.)
 */
async function publishError(topic: string, payload: string): Promise<string> {
  try {
    await stub().publish(topic, payload);
  } catch (err) {
    return String(err);
  }
  throw new Error("publish unexpectedly succeeded");
}

describe("MqttBridge", () => {
  it("stays unconfigured without broker secrets and keeps its watchdog alarm", async () => {
    const s = stub();
    const status = await s.ensureConnected();
    expect(status.state).toBe("unconfigured");
    await runInDurableObject(s, async (_obj, state) => {
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await runDurableObjectAlarm(s)).toBe(true);
    expect((await s.status()).state).toBe("unconfigured");
  });

  it.each([
    "pettracker/backend/dog001/telemetry/gps",
    "pettracker/device/+/command/reboot",
    "pettracker/device/dog001",
  ])("refuses to publish to %s", async (topic) => {
    expect(await publishError(topic, "{}")).toMatch(/refusing to publish/);
  });

  it("refuses oversized payloads", async () => {
    expect(
      await publishError("pettracker/device/dog001/command/buzzer", "x".repeat(16 * 1024 + 1)),
    ).toMatch(/too large/);
  });

  it("refuses to publish while disconnected", async () => {
    expect(await publishError("pettracker/device/dog001/command/reboot", "{}")).toMatch(
      /not connected/,
    );
  });
});

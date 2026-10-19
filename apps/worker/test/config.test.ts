import { describe, expect, it } from "vitest";
import { readMqttConfig } from "../src/bridge/config.js";
import type { Env } from "../src/env.js";

const base = {
  MQTT_CLIENT_ID: "bridge-test",
  MQTT_KEEPALIVE_SECONDS: "60",
  HIVEMQ_HOST: "broker.hivemq.com",
} as unknown as Env;

describe("readMqttConfig", () => {
  it("builds the TLS WebSocket URL with credentials", () => {
    const cfg = readMqttConfig({ ...base, HIVEMQ_USERNAME: "u", HIVEMQ_PASSWORD: "p" });
    expect(cfg).toEqual({
      url: "https://broker.hivemq.com:8884/mqtt",
      clientId: "bridge-test",
      username: "u",
      password: "p",
      keepAliveSeconds: 60,
    });
  });

  it("allows an anonymous broker (no username and no password)", () => {
    const cfg = readMqttConfig({ ...base, HIVEMQ_USERNAME: "", HIVEMQ_PASSWORD: "" });
    expect(cfg).not.toBeNull();
    expect(cfg).not.toHaveProperty("username");
    expect(cfg).not.toHaveProperty("password");
  });

  it("rejects only one of username/password", () => {
    expect(readMqttConfig({ ...base, HIVEMQ_USERNAME: "u" })).toBeNull();
    expect(readMqttConfig({ ...base, HIVEMQ_PASSWORD: "p" })).toBeNull();
  });

  it("rejects a missing host", () => {
    expect(readMqttConfig({ ...base, HIVEMQ_HOST: " " })).toBeNull();
  });
});

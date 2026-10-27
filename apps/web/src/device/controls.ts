import { COMMAND_NAMES, SETTING_NAMES } from "@udara/contracts";

/** One thing the backend can publish for a section: a command or a settings set/get. */
export interface Control {
  /** Published path, e.g. `settings/set/gps_settings`. */
  path: string;
  label: string;
  /** Why it belongs to this section. */
  hint: string;
}

const command = (name: string, hint: string): Control => ({
  path: `command/${name}`,
  label: name,
  hint,
});

const settingControls = (setting: string, hint: string): Control[] => [
  { path: `settings/set/${setting}`, label: `set ${setting}`, hint },
  { path: `settings/get/${setting}`, label: `get ${setting}`, hint: "read the current values" },
];

/**
 * Commands and settings that relate to a topic section of the Device tab (spec V3 §4, §6).
 * Every topic gets at least one control; responses and ACKs map back to the request they answer.
 */
export function controlsFor(topicKey: string): Control[] {
  const [category = "", name = "", setting = ""] = topicKey.split("/");
  switch (topicKey) {
    case "telemetry/gps":
      return [
        ...settingControls("gps_settings", "how often the collar reports GPS"),
        command("location", "ask for a fix now"),
      ];
    case "telemetry/battery":
      return [
        ...settingControls("power_settings", "power mode and low battery alert"),
        command("sleep", "power saving mode"),
      ];
    case "telemetry/imu":
    case "telemetry/bme_data":
      return [
        ...settingControls("sensor_settings", "sensor sampling and switches"),
        command("peripheral", "turn a peripheral on or off"),
      ];
    case "telemetry/signal_strength":
    case "status/network":
      return [
        ...settingControls("network_settings", "MQTT heartbeat and telemetry intervals"),
        command("reboot", "reconnect a stuck modem"),
      ];
    case "status/system":
    case "status/connectivity":
      return [
        ...settingControls("device_settings", "display, audio and alert switches"),
        command("reboot", "restart the collar"),
        command("sleep", "sleep mode"),
      ];
  }
  if (category === "event") {
    return [command("buzzer", "help find the dog"), command("location", "ask for a fix now")];
  }
  if (category === "response" && (COMMAND_NAMES as string[]).includes(name)) {
    return [command(name, "send this command again")];
  }
  if (
    category === "settings" &&
    (name === "response" || name === "ack") &&
    (SETTING_NAMES as string[]).includes(setting)
  ) {
    return settingControls(setting, "change these settings");
  }
  if (category === "diagnostic") return [command("reboot", "restart after a fault")];
  return [];
}

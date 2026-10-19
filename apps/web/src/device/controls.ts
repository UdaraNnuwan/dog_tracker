import { COMMAND_NAMES, SETTING_NAMES } from "@udara/contracts";

/** One thing the backend can publish for a section: a command or a settings set/get. */
export interface Control {
  /** Published path, e.g. `settings/set/gps_interval`. */
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
  { path: `settings/get/${setting}`, label: `get ${setting}`, hint: "read the current value" },
];

/**
 * Commands and settings that relate to a topic section of the Device tab (spec §7, §8).
 * Every topic gets at least one control; responses map back to the request they answer.
 */
export function controlsFor(topicKey: string): Control[] {
  const [category = "", name = "", setting = ""] = topicKey.split("/");
  switch (topicKey) {
    case "telemetry/gps":
      return [
        ...settingControls("gps_interval", "how often the collar reports GPS"),
        command("location", "ask for a fix now"),
      ];
    case "telemetry/battery":
      return [command("sleep", "power saving mode")];
    case "telemetry/imu":
      return [command("peripheral", "turn a sensor on or off")];
    case "telemetry/signal_strength":
    case "status/network":
      return [command("reboot", "reconnect a stuck modem")];
    case "status/system":
    case "status/connectivity":
      return [command("reboot", "restart the collar"), command("sleep", "sleep mode")];
  }
  if (category === "event") {
    return [command("buzzer", "help find the dog"), command("location", "ask for a fix now")];
  }
  if (category === "response" && (COMMAND_NAMES as string[]).includes(name)) {
    return [command(name, "send this command again")];
  }
  if (
    category === "settings" &&
    name === "response" &&
    (SETTING_NAMES as string[]).includes(setting)
  ) {
    return settingControls(setting, "change this setting");
  }
  if (category === "diagnostic") return [command("reboot", "restart after a fault")];
  return [];
}

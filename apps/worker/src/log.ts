export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  device_id?: string;
  topic?: string;
  request_id?: string;
  [key: string]: unknown;
}

export type Logger = (level: LogLevel, msg: string, fields?: LogFields) => void;

/** Structured JSON logging: `{level, msg, device_id?, topic?, request_id?, ...}`. */
export const log: Logger = (level, msg, fields) => {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

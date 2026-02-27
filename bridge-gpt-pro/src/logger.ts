import pino, { type Logger } from "pino";

export interface LoggerConfig {
  level: "debug" | "info" | "warn" | "error";
  format: "json" | "pretty";
}

export function createLogger(config: LoggerConfig): Logger {
  if (config.format === "pretty") {
    return pino({
      level: config.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          destination: 2,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
        },
      },
    });
  }

  return pino(
    {
      level: config.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.destination({ dest: 2, sync: false }),
  );
}

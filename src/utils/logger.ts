import pino, { type LoggerOptions } from "pino";

const isPretty = process.env.NODE_ENV !== "production" && process.stdout.isTTY;

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  redact: {
    remove: true,
    paths: [
      "browser",
      "helloMsg",
      "node",
      "devicePairingData",
      "userAgent",
      "*.eRegid",
      "*.eKeytype",
      "*.eIdent",
      "*.eSkeyVal",
      "*.eSkeySig",
    ],
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
  transport: isPretty
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss",
          singleLine: false,
          ignore: "pid,hostname,browser,helloMsg,node",
          messageKey: "msg",
        },
      }
    : undefined,
};

const logger = pino(options);

export default logger;

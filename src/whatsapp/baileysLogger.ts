import pino from "pino";
import { config } from "../../config/options";

/** Baileys logs through pino; BAILEYS_LOG_LEVEL (default error) keeps its chatter out of the service log. */
export const baileysLogger = pino({ level: config.whatsapp.baileysLogLevel });

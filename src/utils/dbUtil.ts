// Module Imports
import Knex from "knex";
// File Imports
import { config } from "../../config/options";
import { logger } from "./logger";
import { IPgConfig, IPgPoolConfig } from "../types/index";

const commonConfig = {
    host: config.db.host,
    user: config.db.user,
    port: config.db.port,
    password: config.db.password,
    database: config.db.database,
    keepAlive: true,
};

let pgconfig: IPgConfig;

// DB_SSL=false turns SSL off in any environment (a Postgres without SSL, as in
// the platform compose); fin_migrations honours the same switch.
if (config.env === "LOCAL" || process.env.DB_SSL === "false") {
    pgconfig = { ...commonConfig };
} else if (config.env === "STAGING") {
    pgconfig = {
        ...commonConfig,
        ssl: {
            require: true,
            rejectUnauthorized: false,
        },
    };
} else {
    pgconfig = {
        ...commonConfig,
        ssl: {
            require: true,
            rejectUnauthorized: true,
        },
    };
}

const pgpool: IPgPoolConfig = {
    min: config.pool.min,
    max: config.pool.max,
};

const connection = Knex({
    client: "postgresql",
    connection: pgconfig,
    pool: pgpool,
});

logger.info(
    `DB Connection Settings: host=${pgconfig.host} port=${pgconfig.port} database=${pgconfig.database} user=${pgconfig.user}`
);

connection.on("error", function (err: Error) {
    logger.error(`idle client error, ${err.message} | ${err.stack}`);
});
connection
    .raw("SELECT 1")
    .then(() => {
        logger.info("PostgreSQL connected");
    })
    .catch((e) => {
        logger.error(`PostgreSQL not connected, ${e.message} | ${e.stack}`);
    });
export default connection;

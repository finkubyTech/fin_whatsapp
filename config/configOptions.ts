import { config } from "./options";

export const options = {
    db: {
        host: config.db.host,
        username: config.db.user,
        password: config.db.password,
        port: config.db.port,
        schema: config.db.database,
    },
    // Gateway prefix for every fin_whatsapp route (nginx: /api/whatsapp -> fin_whatsapp:5109).
    defaultRouteURL: "/api/whatsapp",
    nodePath: config.env,
};

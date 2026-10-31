import { Router, Request, Response, NextFunction } from "express";
import { sendApiResponse, getOkResponse } from "../utils/apiResponse";
import { validateSchema } from "../utils/validateSchema";
import { actorId, requirePermission } from "../utils/jwt";
import * as svc from "../services/sessionService";
import {
    createSessionSchema,
    pairingCodeSchema,
    renameSessionSchema,
    sessionSettingsSchema,
} from "../schemas/sessionSchemas";
import { bindSessionParam, sessionOf } from "./common";

// Linked WhatsApp numbers: /api/whatsapp/sessions. Viewing needs whatsapp_read,
// everything that changes a number needs whatsapp_admin.
const sessionRouter: Router = Router();
bindSessionParam(sessionRouter);
const read = requirePermission("whatsapp_read");
const admin = requirePermission("whatsapp_admin");

sessionRouter.get("/", read, (req: Request, res: Response, next: NextFunction) => {
    sendApiResponse(req, res, next, async () => {
        const sessions = await svc.listSessions();
        return getOkResponse(sessions, sessions.length, "WhatsApp numbers fetched");
    });
});

sessionRouter.post(
    "/",
    admin,
    validateSchema(createSessionSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const session = await svc.createSession(req.body, actorId(req));
            return getOkResponse(
                session,
                0,
                "WhatsApp number added; start it and scan the QR to link it",
                201
            );
        });
    }
);

sessionRouter.get("/:session", read, (req: Request, res: Response, next: NextFunction) => {
    sendApiResponse(req, res, next, async () =>
        getOkResponse(svc.getSession(sessionOf(res)), 0, "WhatsApp number fetched")
    );
});

sessionRouter.patch(
    "/:session",
    admin,
    validateSchema(renameSessionSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await svc.updateSessionName(sessionOf(res), req.body.name),
                0,
                "WhatsApp number renamed"
            )
        );
    }
);

sessionRouter.delete("/:session", admin, (req: Request, res: Response, next: NextFunction) => {
    sendApiResponse(req, res, next, async () => {
        await svc.deleteSession(sessionOf(res));
        return getOkResponse({}, 0, "WhatsApp number logged out and deleted");
    });
});

sessionRouter.get("/:session/qr", admin, (req: Request, res: Response, next: NextFunction) => {
    sendApiResponse(req, res, next, async () =>
        getOkResponse(await svc.getQr(sessionOf(res)), 0, "QR fetched")
    );
});

for (const action of ["start", "stop", "restart", "logout"] as const) {
    sessionRouter.post(
        `/:session/${action}`,
        admin,
        (req: Request, res: Response, next: NextFunction) => {
            sendApiResponse(req, res, next, async () =>
                getOkResponse(
                    await svc[action](sessionOf(res)),
                    0,
                    `WhatsApp number: ${action} done`
                )
            );
        }
    );
}

sessionRouter.post(
    "/:session/pairing-code",
    admin,
    validateSchema(pairingCodeSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await svc.requestPairingCode(sessionOf(res), req.body.phone),
                0,
                "Enter this code on the phone"
            )
        );
    }
);

sessionRouter.get(
    "/:session/settings",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(await svc.getSessionSettings(sessionOf(res)), 0, "Settings fetched")
        );
    }
);

sessionRouter.put(
    "/:session/settings",
    admin,
    validateSchema(sessionSettingsSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await svc.updateSessionSettings(sessionOf(res), req.body, actorId(req)),
                0,
                "Settings saved"
            )
        );
    }
);

export default sessionRouter;

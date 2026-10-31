import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import createHttpError from "http-errors";
import { config } from "../../config/options";
import { sendApiResponse, getOkResponse, sendErrorResponse } from "../utils/apiResponse";
import { validateSchema } from "../utils/validateSchema";
import { requirePermission } from "../utils/jwt";
import * as svc from "../services/messageService";
import {
    reactSchema,
    sendContactSchema,
    sendLocationSchema,
    sendMediaSchema,
    sendTextSchema,
} from "../schemas/messageSchemas";
import { bindSessionParam, sessionOf } from "./common";

// Sending: /api/whatsapp/sessions/:session/messages/*, whatsapp_send. Nothing
// goes to a number on the opt-out list (409). The stored copy and the
// message.sent webhook follow once WhatsApp accepts the message.
const messageRouter: Router = Router();
bindSessionParam(messageRouter);
const sendPerm = requirePermission("whatsapp_send");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.whatsapp.maxUploadBytes, files: 1 },
});
/** Optional multipart `file`; multer errors become the standard envelope. */
const fileField = (req: Request, res: Response, next: NextFunction) => {
    if (!req.is("multipart/form-data")) return next();
    upload.single("file")(req, res, (err: any) => {
        if (!err) return next();
        if (err.code === "LIMIT_FILE_SIZE") {
            return sendErrorResponse(
                res,
                new createHttpError.PayloadTooLarge(
                    `File is too large. Maximum size is ${Math.round(config.whatsapp.maxUploadBytes / 1048576)} MB.`
                )
            );
        }
        return sendErrorResponse(
            res,
            new createHttpError.BadRequest(err.message || "Invalid upload")
        );
    });
};

messageRouter.post(
    "/:session/messages/text",
    sendPerm,
    validateSchema(sendTextSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(await svc.sendText(sessionOf(res), req.body), 0, "Message sent")
        );
    }
);

messageRouter.post(
    "/:session/messages/media",
    sendPerm,
    fileField,
    validateSchema(sendMediaSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(await svc.sendMedia(sessionOf(res), req.body, req.file), 0, "Media sent")
        );
    }
);

messageRouter.post(
    "/:session/messages/location",
    sendPerm,
    validateSchema(sendLocationSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(await svc.sendLocation(sessionOf(res), req.body), 0, "Location sent")
        );
    }
);

messageRouter.post(
    "/:session/messages/contact",
    sendPerm,
    validateSchema(sendContactSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(await svc.sendContactCard(sessionOf(res), req.body), 0, "Contact sent")
        );
    }
);

messageRouter.post(
    "/:session/messages/:keyId/react",
    sendPerm,
    validateSchema(reactSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await svc.react(sessionOf(res), String(req.params.keyId), req.body.emoji),
                0,
                "Reaction sent"
            )
        );
    }
);

messageRouter.delete(
    "/:session/messages/:keyId",
    sendPerm,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await svc.deleteForEveryone(sessionOf(res), String(req.params.keyId)),
                0,
                "Message deleted for everyone"
            )
        );
    }
);

messageRouter.post(
    "/:session/chats/:jid/read",
    sendPerm,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await svc.markRead(sessionOf(res), String(req.params.jid)),
                0,
                "Chat marked read"
            )
        );
    }
);

export default messageRouter;

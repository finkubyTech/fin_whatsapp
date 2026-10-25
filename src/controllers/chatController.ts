import { Router, Request, Response, NextFunction } from "express";
import { sendApiResponse, getOkResponse } from "../utils/apiResponse";
import { validateSchema } from "../utils/validateSchema";
import { requirePermission } from "../utils/jwt";
import * as chats from "../services/chatService";
import * as labels from "../services/labelService";
import {
    chatLabelsSchema,
    createLabelSchema,
    listChatsSchema,
    listMessagesSchema,
    updateLabelSchema,
} from "../schemas/chatSchemas";
import { bindSessionParam, sessionOf } from "./common";

// Chats and labels: /api/whatsapp/sessions/:session/{chats,labels}.
// Reading: whatsapp_read. Labelling: whatsapp_send. Deleting stored chats: whatsapp_admin.
const chatRouter: Router = Router();
bindSessionParam(chatRouter);
const read = requirePermission("whatsapp_read");
const sendPerm = requirePermission("whatsapp_send");
const admin = requirePermission("whatsapp_admin");

chatRouter.get(
    "/:session/chats",
    read,
    validateSchema(listChatsSchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(
            req,
            res,
            next,
            async () => chats.listChats(sessionOf(res), req.query) as any
        );
    }
);

chatRouter.get(
    "/:session/chats/:jid/messages",
    read,
    validateSchema(listMessagesSchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const page = await chats.listMessages(
                sessionOf(res),
                String(req.params.jid),
                req.query
            );
            return getOkResponse(page, page.messages.length, "Messages fetched");
        });
    }
);

chatRouter.delete(
    "/:session/chats/:jid/stored",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await chats.deleteStoredChat(sessionOf(res), String(req.params.jid)),
                0,
                "Stored chat deleted"
            )
        );
    }
);

chatRouter.get(
    "/:session/chats/:jid/labels",
    read,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const rows = await labels.chatLabels(sessionOf(res), String(req.params.jid));
            return getOkResponse(rows, rows.length, "Chat labels fetched");
        });
    }
);

chatRouter.put(
    "/:session/chats/:jid/labels",
    sendPerm,
    validateSchema(chatLabelsSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const rows = await labels.changeChatLabels(
                sessionOf(res),
                String(req.params.jid),
                req.body
            );
            return getOkResponse(rows, rows.length, "Chat labels saved");
        });
    }
);

chatRouter.get("/:session/labels", read, (req: Request, res: Response, next: NextFunction) => {
    sendApiResponse(req, res, next, async () => {
        const rows = await labels.listLabels(sessionOf(res));
        return getOkResponse(rows, rows.length, "Labels fetched");
    });
});

chatRouter.post(
    "/:session/labels",
    sendPerm,
    validateSchema(createLabelSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await labels.createLabel(sessionOf(res), req.body),
                0,
                "Label created",
                201
            )
        );
    }
);

chatRouter.patch(
    "/:session/labels/:labelId",
    sendPerm,
    validateSchema(updateLabelSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await labels.updateLabel(sessionOf(res), String(req.params.labelId), req.body),
                0,
                "Label updated"
            )
        );
    }
);

chatRouter.delete(
    "/:session/labels/:labelId",
    sendPerm,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            await labels.deleteLabel(sessionOf(res), String(req.params.labelId));
            return getOkResponse({}, 0, "Label deleted");
        });
    }
);

export default chatRouter;

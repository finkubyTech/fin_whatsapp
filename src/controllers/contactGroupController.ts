import { Router, Request, Response, NextFunction } from "express";
import { sendApiResponse, getOkResponse } from "../utils/apiResponse";
import { validateSchema } from "../utils/validateSchema";
import { requirePermission } from "../utils/jwt";
import * as contacts from "../services/contactService";
import * as groups from "../services/groupService";
import {
    checkNumbersSchema,
    createGroupSchema,
    joinGroupSchema,
    listContactsSchema,
    participantsSchema,
    updateGroupSchema,
} from "../schemas/contactGroupSchemas";
import { bindSessionParam, sessionOf } from "./common";

// Contacts and groups: /api/whatsapp/sessions/:session/{contacts,groups}.
// Reading: whatsapp_read. Checking numbers: whatsapp_send. Blocking and every group change: whatsapp_admin.
const contactGroupRouter: Router = Router();
bindSessionParam(contactGroupRouter);
const read = requirePermission("whatsapp_read");
const sendPerm = requirePermission("whatsapp_send");
const admin = requirePermission("whatsapp_admin");

contactGroupRouter.get(
    "/:session/contacts",
    read,
    validateSchema(listContactsSchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(
            req,
            res,
            next,
            async () => contacts.listContacts(sessionOf(res), req.query) as any
        );
    }
);

contactGroupRouter.post(
    "/:session/contacts/check",
    sendPerm,
    validateSchema(checkNumbersSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const rows = await contacts.checkNumbers(sessionOf(res), req.body.numbers);
            return getOkResponse(rows, rows.length, "Numbers checked");
        });
    }
);

contactGroupRouter.get(
    "/:session/contacts/lid/:lid",
    read,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await contacts.phoneForLid(sessionOf(res), String(req.params.lid)),
                0,
                "Phone number found"
            )
        );
    }
);

contactGroupRouter.get(
    "/:session/contacts/:jid",
    read,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await contacts.getContact(sessionOf(res), String(req.params.jid)),
                0,
                "Contact fetched"
            )
        );
    }
);

for (const [path, block] of [
    ["block", true],
    ["unblock", false],
] as const) {
    contactGroupRouter.post(
        `/:session/contacts/:jid/${path}`,
        admin,
        (req: Request, res: Response, next: NextFunction) => {
            sendApiResponse(req, res, next, async () =>
                getOkResponse(
                    await contacts.setBlocked(sessionOf(res), String(req.params.jid), block),
                    0,
                    block ? "Contact blocked" : "Contact unblocked"
                )
            );
        }
    );
}

contactGroupRouter.get(
    "/:session/groups",
    read,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const rows = await groups.listGroups(sessionOf(res));
            return getOkResponse(rows, rows.length, "Groups fetched");
        });
    }
);

contactGroupRouter.post(
    "/:session/groups",
    admin,
    validateSchema(createGroupSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await groups.createGroup(sessionOf(res), req.body),
                0,
                "Group created",
                201
            )
        );
    }
);

contactGroupRouter.post(
    "/:session/groups/join",
    admin,
    validateSchema(joinGroupSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await groups.joinGroup(sessionOf(res), req.body.code),
                0,
                "Joined the group"
            )
        );
    }
);

contactGroupRouter.get(
    "/:session/groups/:jid",
    read,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await groups.getGroup(sessionOf(res), String(req.params.jid)),
                0,
                "Group fetched"
            )
        );
    }
);

contactGroupRouter.patch(
    "/:session/groups/:jid",
    admin,
    validateSchema(updateGroupSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await groups.updateGroup(sessionOf(res), String(req.params.jid), req.body),
                0,
                "Group updated"
            )
        );
    }
);

contactGroupRouter.post(
    "/:session/groups/:jid/participants",
    admin,
    validateSchema(participantsSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const rows = await groups.changeParticipants(
                sessionOf(res),
                String(req.params.jid),
                req.body
            );
            return getOkResponse(rows, rows.length, "Participants updated");
        });
    }
);

contactGroupRouter.get(
    "/:session/groups/:jid/invite-code",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await groups.inviteCode(sessionOf(res), String(req.params.jid), false),
                0,
                "Invite link fetched"
            )
        );
    }
);

contactGroupRouter.post(
    "/:session/groups/:jid/invite-code/revoke",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await groups.inviteCode(sessionOf(res), String(req.params.jid), true),
                0,
                "Invite link replaced"
            )
        );
    }
);

contactGroupRouter.post(
    "/:session/groups/:jid/leave",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await groups.leaveGroup(sessionOf(res), String(req.params.jid)),
                0,
                "Left the group"
            )
        );
    }
);

export default contactGroupRouter;

import { Router, Request, Response, NextFunction } from "express";
import { sendApiResponse, getOkResponse } from "../utils/apiResponse";
import { validateSchema } from "../utils/validateSchema";
import { actorId, requirePermission } from "../utils/jwt";
import * as autoReplies from "../services/autoReplyService";
import * as optOuts from "../services/optOutService";
import * as schedules from "../services/scheduleService";
import * as broadcasts from "../services/broadcastService";
import * as webhooks from "../services/webhookService";
import * as s from "../schemas/automationSchemas";
import { bindSessionParam, sessionOf } from "./common";

// Automations: /api/whatsapp/sessions/:session/{auto-replies,opt-outs,schedules,broadcasts,webhooks}.
// All need whatsapp_admin.
const automationRouter: Router = Router();
bindSessionParam(automationRouter);
const admin = requirePermission("whatsapp_admin");

const id = (req: Request) => String(req.params.id);

// ---- auto-replies
automationRouter.get(
    "/:session/auto-replies",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const rows = await autoReplies.listAutoReplies(sessionOf(res));
            return getOkResponse(rows, rows.length, "Auto-replies fetched");
        });
    }
);
automationRouter.post(
    "/:session/auto-replies",
    admin,
    validateSchema(s.createAutoReplySchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await autoReplies.createAutoReply(sessionOf(res), req.body, actorId(req)),
                0,
                "Auto-reply created",
                201
            )
        );
    }
);
automationRouter.patch(
    "/:session/auto-replies/:id",
    admin,
    validateSchema(s.updateAutoReplySchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await autoReplies.updateAutoReply(sessionOf(res), id(req), req.body, actorId(req)),
                0,
                "Auto-reply updated"
            )
        );
    }
);
automationRouter.delete(
    "/:session/auto-replies/:id",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            await autoReplies.deleteAutoReply(sessionOf(res), id(req));
            return getOkResponse({}, 0, "Auto-reply deleted");
        });
    }
);

// ---- opt-outs
automationRouter.get(
    "/:session/opt-outs",
    admin,
    validateSchema(s.listOptOutsSchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(
            req,
            res,
            next,
            async () => optOuts.listOptOuts(sessionOf(res), req.query) as any
        );
    }
);
automationRouter.post(
    "/:session/opt-outs",
    admin,
    validateSchema(s.addOptOutSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await optOuts.addOptOut(sessionOf(res), req.body, actorId(req)),
                0,
                "Number opted out",
                201
            )
        );
    }
);
automationRouter.post(
    "/:session/opt-outs/:id/remove",
    admin,
    validateSchema(s.removeOptOutSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await optOuts.removeOptOut(sessionOf(res), id(req), req.body.reason, actorId(req)),
                0,
                "Opt-out removed"
            )
        );
    }
);

// ---- scheduled messages
automationRouter.get(
    "/:session/schedules",
    admin,
    validateSchema(s.listSchedulesSchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(
            req,
            res,
            next,
            async () => schedules.listSchedules(sessionOf(res), req.query) as any
        );
    }
);
automationRouter.post(
    "/:session/schedules",
    admin,
    validateSchema(s.createScheduleSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await schedules.createSchedule(sessionOf(res), req.body, actorId(req)),
                0,
                "Message scheduled",
                201
            )
        );
    }
);
automationRouter.patch(
    "/:session/schedules/:id",
    admin,
    validateSchema(s.updateScheduleSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await schedules.updateSchedule(sessionOf(res), id(req), req.body),
                0,
                "Scheduled message updated"
            )
        );
    }
);
automationRouter.post(
    "/:session/schedules/:id/cancel",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await schedules.cancelSchedule(sessionOf(res), id(req)),
                0,
                "Scheduled message cancelled"
            )
        );
    }
);

// ---- broadcasts
automationRouter.get(
    "/:session/broadcasts",
    admin,
    validateSchema(s.broadcastQuerySchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(
            req,
            res,
            next,
            async () => broadcasts.listBroadcasts(sessionOf(res), req.query) as any
        );
    }
);
automationRouter.post(
    "/:session/broadcasts",
    admin,
    validateSchema(s.createBroadcastSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await broadcasts.createBroadcast(sessionOf(res), req.body, actorId(req)),
                0,
                "Broadcast started",
                201
            )
        );
    }
);
automationRouter.get(
    "/:session/broadcasts/:id",
    admin,
    validateSchema(s.broadcastQuerySchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await broadcasts.getBroadcast(sessionOf(res), id(req), req.query),
                0,
                "Broadcast fetched"
            )
        );
    }
);
automationRouter.post(
    "/:session/broadcasts/:id/cancel",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await broadcasts.cancelBroadcast(sessionOf(res), id(req)),
                0,
                "Broadcast cancelled"
            )
        );
    }
);

// ---- webhooks
automationRouter.get(
    "/:session/webhooks",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            const rows = await webhooks.listWebhooks(sessionOf(res));
            return getOkResponse(rows, rows.length, "Webhooks fetched");
        });
    }
);
automationRouter.post(
    "/:session/webhooks",
    admin,
    validateSchema(s.createWebhookSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await webhooks.createWebhook(sessionOf(res), req.body, actorId(req)),
                0,
                "Webhook created",
                201
            )
        );
    }
);
automationRouter.patch(
    "/:session/webhooks/:id",
    admin,
    validateSchema(s.updateWebhookSchema, "BODY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(
                await webhooks.updateWebhook(sessionOf(res), id(req), req.body),
                0,
                "Webhook updated"
            )
        );
    }
);
automationRouter.delete(
    "/:session/webhooks/:id",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () => {
            await webhooks.deleteWebhook(sessionOf(res), id(req));
            return getOkResponse({}, 0, "Webhook deleted");
        });
    }
);
automationRouter.get(
    "/:session/webhooks/:id/logs",
    admin,
    validateSchema(s.webhookLogsSchema, "QUERY"),
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(
            req,
            res,
            next,
            async () => webhooks.webhookLogs(sessionOf(res), id(req), req.query) as any
        );
    }
);
automationRouter.post(
    "/:session/webhooks/:id/test",
    admin,
    (req: Request, res: Response, next: NextFunction) => {
        sendApiResponse(req, res, next, async () =>
            getOkResponse(await webhooks.testWebhook(sessionOf(res), id(req)), 0, "Test event sent")
        );
    }
);

export default automationRouter;

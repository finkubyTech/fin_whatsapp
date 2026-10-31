import { Router, Request, Response } from "express";
import createHttpError from "http-errors";
import { sendErrorResponse } from "../utils/apiResponse";
import { requirePermission } from "../utils/jwt";
import { mediaPath } from "../whatsapp/media";

// Stored media: /api/whatsapp/media/<name> (the fileUrl in webhooks and message
// lists), whatsapp_read. The file itself, never encrypted, private to staff.
const mediaRouter: Router = Router();

mediaRouter.get("/:name", requirePermission("whatsapp_read"), (req: Request, res: Response) => {
    const full = mediaPath(String(req.params.name));
    if (!full) return sendErrorResponse(res, new createHttpError.NotFound("File not found"));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", "inline");
    res.sendFile(full, (err: any) => {
        if (err && !res.headersSent)
            sendErrorResponse(res, new createHttpError.NotFound("File not found"));
    });
});

export default mediaRouter;

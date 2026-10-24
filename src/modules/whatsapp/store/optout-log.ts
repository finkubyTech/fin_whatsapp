import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/logger";

// Finkuby: WA-AKG has no opt-out list, so every stop/unsubscribe message is recorded where the team can see it.
// - A dashboard notification per message (number + time) for the session owner and everyone with session access.
// - An "Opted out" label on the chat, so the chat list can be filtered by it.
// Nothing here suppresses later replies; it is a record for the team to act on.
export const OPT_OUT_PATTERN = /^\s*(?:stop|unsubscribe)\W*$/i;
const LABEL_NAME = "Opted out";

export async function logOptOut(sessionId: string, chatJid: string, senderJid: string, text: string, pushName?: string | null) {
    try {
        const session = await prisma.session.findUnique({ where: { sessionId }, include: { sessionAccesses: true } });
        if (!session) return;

        const number = senderJid.split("@")[0];
        const at = new Date();
        const userIds = new Set<string>([session.userId, ...(session.sessionAccesses).map((a) => a.userId)]);

        await prisma.notification.createMany({
            data: [...userIds].map((userId) => ({
                userId,
                title: "Opt-out request",
                message: `+${number}${pushName ? ` (${pushName})` : ""} sent "${text.trim()}" on ${sessionId} at ${at.toISOString()}`,
                type: "WARNING",
                href: "/dashboard/labels",
            })),
        });

        const label = await prisma.label.upsert({
            where: { sessionId_name: { sessionId, name: LABEL_NAME } },
            create: { sessionId, name: LABEL_NAME, color: 0, colorHex: "#FF0000" },
            update: {},
        });
        // A contact can appear under two JIDs: the phone number (@s.whatsapp.net) and WhatsApp's internal @lid.
        // WA-AKG files incoming messages under one and replies under the other, so the dashboard shows two chats.
        // Label both, so the label shows on the phone-number chat and the Labels page lists a real number.
        for (const jid of new Set([chatJid, senderJid])) {
            await prisma.chatLabel.upsert({
                where: { labelId_chatJid: { labelId: label.id, chatJid: jid } },
                create: { labelId: label.id, chatJid: jid },
                update: {},
            });
        }

        logger.info("OptOut", `Logged opt-out from +${number} on ${sessionId}`);
    } catch (e) {
        logger.error("OptOut", "Failed to log opt-out", e);
    }
}

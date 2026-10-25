import { safeFetchBuffer } from "../helpers/safeFetch";
import type { MediaKind } from "../types";
import type { OutgoingMessage } from "./sender";

const MIME_FALLBACK: Record<MediaKind, string> = {
    image: "image/jpeg",
    video: "video/mp4",
    audio: "audio/mp4",
    document: "application/octet-stream",
};

/** A stored text / media URL pair (schedules, broadcasts) as a message to send; the media is fetched safely. */
export async function composeMessage(
    text: string | null,
    mediaUrl: string | null,
    mediaType: MediaKind | null
): Promise<OutgoingMessage> {
    if (mediaUrl && mediaType) {
        const file = await safeFetchBuffer(mediaUrl, { maxBytes: 50 * 1024 * 1024 });
        return {
            kind: "media",
            media: mediaType,
            buffer: file.buffer,
            mime:
                file.contentType === "application/octet-stream"
                    ? MIME_FALLBACK[mediaType]
                    : file.contentType,
            fileName: file.fileName,
            caption: text,
        };
    }
    return { kind: "text", text: text || "" };
}

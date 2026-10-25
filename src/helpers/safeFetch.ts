import dns from "dns";
import net from "net";
import { Agent, fetch as undiciFetch } from "undici";

/**
 * Outbound HTTP for URLs that come from API callers or stored settings (media
 * to send, webhook targets). Ported from WA-AKG's security helpers, with one
 * change: the connection goes to the exact IP that was checked, so a DNS answer
 * that changes between the check and the request (DNS rebinding) can't reach an
 * internal address.
 */

export function isPrivateOrReservedIp(ip: string): boolean {
    if (ip.startsWith("::ffff:")) ip = ip.substring(7);

    if (net.isIPv4(ip)) {
        const [a, b, c] = ip.split(".").map(Number);
        return (
            a === 0 ||
            a === 10 ||
            (a === 100 && b >= 64 && b <= 127) || // CGNAT
            a === 127 ||
            (a === 169 && b === 254) || // link-local, cloud metadata
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 0 && (c === 0 || c === 2)) ||
            (a === 192 && b === 88 && c === 99) ||
            (a === 192 && b === 168) ||
            (a === 198 && (b === 18 || b === 19)) ||
            (a === 198 && b === 51 && c === 100) ||
            (a === 203 && b === 0 && c === 113) ||
            a >= 224 // multicast, reserved, broadcast
        );
    }
    if (net.isIPv6(ip)) {
        const v6 = ip.toLowerCase();
        return (
            v6 === "::1" ||
            v6 === "::" ||
            /^fe[89ab]/.test(v6) || // link-local
            v6.startsWith("fc") ||
            v6.startsWith("fd") || // unique local
            v6.startsWith("64:ff9b:") ||
            v6.startsWith("2001:db8:") ||
            v6.startsWith("2002:")
        );
    }
    return true; // unknown format: unsafe
}

export interface UrlPolicy {
    /** Hostnames trusted although they resolve to private addresses (fin_ services); http allowed for them. */
    trustedHosts?: string[];
}

interface Checked {
    url: URL;
    ips: string[];
    trusted: boolean;
}

/** Throws unless the URL is https (or a trusted host) and resolves only to public addresses. */
export async function checkUrl(raw: string, policy: UrlPolicy = {}): Promise<Checked> {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("Malformed URL");
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const trusted = (policy.trustedHosts || []).includes(host);
    if (url.protocol !== "https:" && !(trusted && url.protocol === "http:")) {
        throw new Error(`Only https URLs are allowed (got ${url.protocol})`);
    }
    if (url.username || url.password) throw new Error("URLs with credentials are not allowed");

    let ips: string[];
    if (net.isIP(host)) {
        ips = [host];
    } else {
        if (!trusted && (host === "localhost" || host.endsWith(".localhost"))) {
            throw new Error("localhost is not allowed");
        }
        try {
            ips = (await dns.promises.lookup(host, { all: true })).map((r) => r.address);
        } catch (err: any) {
            throw new Error(`Could not resolve ${host}: ${err.code || err.message}`);
        }
    }
    if (ips.length === 0) throw new Error(`Could not resolve ${host}`);
    if (!trusted) {
        const internal = ips.find(isPrivateOrReservedIp);
        if (internal) throw new Error(`${host} resolves to an internal address (${internal})`);
    }
    return { url, ips, trusted };
}

/** An agent whose every connection goes to the checked addresses. */
const pinnedAgent = (ips: string[]) =>
    new Agent({
        connect: {
            lookup: (_host: string, opts: any, callback: any) => {
                const list = ips.map((address) => ({
                    address,
                    family: net.isIPv6(address) ? 6 : 4,
                }));
                if (opts?.all) callback(null, list);
                else callback(null, list[0].address, list[0].family);
            },
        },
    });

export interface FetchedFile {
    buffer: Buffer;
    contentType: string;
    fileName: string;
}

/**
 * GETs a file with the URL checks, a size cap and a timeout. Redirects are
 * followed by hand (at most 3), each hop checked again.
 */
export async function safeFetchBuffer(
    raw: string,
    {
        maxBytes = 16 * 1024 * 1024,
        timeoutMs = 15_000,
        ...policy
    }: UrlPolicy & { maxBytes?: number; timeoutMs?: number } = {}
): Promise<FetchedFile> {
    let current = raw;
    for (let hop = 0; hop <= 3; hop++) {
        const { url, ips } = await checkUrl(current, policy);
        const dispatcher = pinnedAgent(ips);
        try {
            const res = await undiciFetch(url, {
                redirect: "manual",
                dispatcher,
                signal: AbortSignal.timeout(timeoutMs),
            });
            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get("location");
                if (!location) throw new Error(`Redirect (${res.status}) without a location`);
                current = new URL(location, url).toString();
                continue;
            }
            if (!res.ok) throw new Error(`Remote server answered ${res.status}`);
            const declared = Number(res.headers.get("content-length"));
            if (declared > maxBytes)
                throw new Error(`File is larger than ${Math.round(maxBytes / 1048576)} MB`);
            if (!res.body) throw new Error("Empty response");

            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of res.body) {
                size += chunk.length;
                if (size > maxBytes)
                    throw new Error(`File is larger than ${Math.round(maxBytes / 1048576)} MB`);
                chunks.push(Buffer.from(chunk));
            }
            return {
                buffer: Buffer.concat(chunks),
                contentType:
                    res.headers.get("content-type")?.split(";")[0].trim() ||
                    "application/octet-stream",
                fileName: decodeURIComponent(url.pathname.split("/").pop() || "") || "file",
            };
        } finally {
            dispatcher.close().catch(() => undefined);
        }
    }
    throw new Error("Too many redirects");
}

export interface PostResult {
    status: number;
    body: string;
}

/** POSTs a JSON body (webhooks): same checks, no redirects followed, body read up to 1 KB. */
export async function safePostJson(
    raw: string,
    body: string,
    headers: Record<string, string>,
    { timeoutMs = 10_000, ...policy }: UrlPolicy & { timeoutMs?: number } = {}
): Promise<PostResult> {
    const { url, ips } = await checkUrl(raw, policy);
    const dispatcher = pinnedAgent(ips);
    try {
        const res = await undiciFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body,
            redirect: "manual",
            dispatcher,
            signal: AbortSignal.timeout(timeoutMs),
        });
        const text = (await res.text().catch(() => "")).slice(0, 1024);
        return { status: res.status, body: text };
    } finally {
        dispatcher.close().catch(() => undefined);
    }
}

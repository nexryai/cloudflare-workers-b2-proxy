/**
 * S3-Compatible API Server on Cloudflare Workers
 * Backend: Backblaze B2 with aws4fetch for S3-compatible access
 */

import { AwsClient } from "aws4fetch";

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        try {
            if (request.method === "OPTIONS") {
                return new Response(null, { status: 204 });
            }

            const url = new URL(request.url);
            const method = request.method;

            // パスからバケット名とオブジェクトキーを抽出
            const pathParts = url.pathname.split("/").filter((p) => p);
            const bucket = pathParts[0] || "";
            const objectKey = pathParts.slice(1).join("/");

            if (!isAllowedBucket(bucket, env)) {
                return new Response("Access denied to this bucket", { status: 403 });
            }

            const isValid = await verifySignature(request, env);
            if (!isValid) {
                return new Response("Invalid Signature", { status: 403 });
            }

            // B2クライアントの初期化
            const b2Client = new AwsClient({
                accessKeyId: env.B2_KEY_ID,
                secretAccessKey: env.B2_APPLICATION_KEY,
                region: env.B2_REGION || "us-west-000",
                service: "s3",
            });

            const b2Endpoint = env.B2_ENDPOINT; // 例: s3.us-west-000.backblazeb2.com

            if (method === "PUT" || method === "POST") {
                // アップロード
                if (!objectKey) {
                    return new Response("Object key required", { status: 400 });
                }

                const contentType = request.headers.get("Content-Type") || "application/octet-stream";
                const result = await uploadToB2(b2Client, b2Endpoint, bucket, objectKey, request.body, contentType);

                return new Response(JSON.stringify(result), {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        ETag: result.etag || "",
                    },
                });
            } else if (method === "GET") {
                // ダウンロードまたはリスト
                if (!objectKey) {
                    // バケット内のオブジェクト一覧
                    const files = await listB2Objects(b2Client, b2Endpoint, bucket);
                    return new Response(files, {
                        status: 200,
                        headers: { "Content-Type": "application/xml" },
                    });
                }

                try {
                    const fileStream = await downloadFromB2(b2Client, b2Endpoint, bucket, objectKey);

                    return new Response(fileStream.body, {
                        status: 200,
                        headers: {
                            "Content-Type": fileStream.contentType,
                            "Content-Length": fileStream.contentLength,
                            "Cache-Control": "s-maxage=300, no-store",
                            ETag: fileStream.etag,
                        },
                    });
                } catch (e) {
                    const error = e as Error;
                    if (error.message.includes("404") || error.message.includes("NoSuchKey")) {
                        return new Response("NoSuchKey", { status: 404 });
                    }
                    throw e;
                }
            } else if (method === "DELETE") {
                // オブジェクト削除
                if (!objectKey) {
                    return new Response("Object key required", { status: 400 });
                }

                try {
                    await deleteFromB2(b2Client, b2Endpoint, bucket, objectKey);
                    return new Response(null, { status: 204 });
                } catch (e) {
                    const error = e as Error;
                    if (error.message.includes("404") || error.message.includes("NoSuchKey")) {
                        return new Response(null, { status: 404 });
                    }
                    throw e;
                }
            } else if (method === "HEAD") {
                // メタデータ取得
                if (!objectKey) {
                    return new Response(null, { status: 400 });
                }

                try {
                    const metadata = await headB2Object(b2Client, b2Endpoint, bucket, objectKey);
                    return new Response(null, {
                        status: 200,
                        headers: {
                            "Content-Type": metadata.contentType,
                            "Content-Length": metadata.contentLength,
                            ETag: metadata.etag,
                        },
                    });
                } catch (e) {
                    const error = e as Error;
                    if (error.message.includes("404") || error.message.includes("NoSuchKey")) {
                        return new Response(null, { status: 404 });
                    }
                    throw e;
                }
            }

            return new Response("Method not allowed", { status: 405 });
        } catch (e) {
            const error = e as Error;
            console.error("Error:", error);
            return new Response(error.message, { status: 500 });
        }
    },
} satisfies ExportedHandler<Env>;

interface Env {
    ACCESS_KEY: string;
    SECRET_KEY: string;
    REGION: string;
    B2_KEY_ID: string;
    B2_APPLICATION_KEY: string;
    B2_ENDPOINT: string;
    B2_REGION?: string;
    ALLOWED_BUCKETS?: string;
}

function isAllowedBucket(bucket: string, env: Env): boolean {
    console.log(bucket);
    // 許可リストが設定されていない場合はすべて拒否
    if (!env.ALLOWED_BUCKETS) {
        return false;
    }

    const allowedBuckets = env.ALLOWED_BUCKETS.split(",")
        .map((b) => b.trim())
        .filter((b) => b);

    // 空の許可リストの場合もすべて拒否
    if (allowedBuckets.length === 0) {
        return false;
    }

    // バケット名が許可リストに含まれているかチェック
    return allowedBuckets.includes(bucket);
}

// ========================================
// Backblaze B2 API Functions (via aws4fetch)
// ========================================

async function uploadToB2(client: AwsClient, endpoint: string, bucket: string, objectKey: string, body: ReadableStream | null, contentType: string): Promise<{ etag?: string }> {
    if (!body) {
        throw new Error("Request body is required");
    }

    const url = `https://${endpoint}/${bucket}/${objectKey}`;

    const response = await client.fetch(url, {
        method: "PUT",
        headers: {
            "Content-Type": contentType,
        },
        body: body,
        duplex: "half",
    } as RequestInit);

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
    }

    return {
        etag: response.headers.get("ETag") || undefined,
    };
}

async function downloadFromB2(client: AwsClient, endpoint: string, bucket: string, objectKey: string): Promise<{ body: ReadableStream; contentType: string; contentLength: string; etag: string }> {
    const url = `https://${endpoint}/${bucket}/${objectKey}`;

    const response = await client.fetch(url, {
        method: "GET",
    });

    if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
    }

    return {
        body: response.body!,
        contentType: response.headers.get("Content-Type") || "application/octet-stream",
        contentLength: response.headers.get("Content-Length") || "0",
        etag: response.headers.get("ETag") || '""',
    };
}

async function deleteFromB2(client: AwsClient, endpoint: string, bucket: string, objectKey: string): Promise<void> {
    const url = `https://${endpoint}/${bucket}/${objectKey}`;

    const response = await client.fetch(url, {
        method: "DELETE",
    });

    if (!response.ok) {
        throw new Error(`Delete failed: ${response.status}`);
    }
}

async function headB2Object(client: AwsClient, endpoint: string, bucket: string, objectKey: string): Promise<{ contentType: string; contentLength: string; etag: string }> {
    const url = `https://${endpoint}/${bucket}/${objectKey}`;

    const response = await client.fetch(url, {
        method: "HEAD",
    });

    if (!response.ok) {
        throw new Error(`HEAD failed: ${response.status}`);
    }

    return {
        contentType: response.headers.get("Content-Type") || "application/octet-stream",
        contentLength: response.headers.get("Content-Length") || "0",
        etag: response.headers.get("ETag") || '""',
    };
}

async function listB2Objects(client: AwsClient, endpoint: string, bucket: string): Promise<string> {
    const url = `https://${endpoint}/${bucket}`;

    const response = await client.fetch(url, {
        method: "GET",
    });

    if (!response.ok) {
        throw new Error(`List failed: ${response.status}`);
    }

    return await response.text();
}

// ========================================
// AWS Signature V4 Verification
// ========================================

async function verifySignature(request: Request, env: Env): Promise<boolean> {
    const url = new URL(request.url);
    const headers = request.headers;

    const isQueryAuth = url.searchParams.has("X-Amz-Algorithm");

    let algorithm: string;
    if (isQueryAuth) {
        algorithm = url.searchParams.get("X-Amz-Algorithm") ?? "";
    } else {
        const authHeader = headers.get("Authorization") ?? "";
        algorithm = authHeader.split(" ")[0];
    }

    if (!algorithm || !algorithm.includes("AWS4-HMAC-SHA256")) {
        return false;
    }

    const datetime = (isQueryAuth ? url.searchParams.get("X-Amz-Date") : headers.get("x-amz-date")) ?? "";

    if (!datetime) return false;

    const date = datetime.substring(0, 8);

    const canonicalRequest = await createCanonicalRequest(request, isQueryAuth);
    const hashedCanonicalRequest = await sha256(canonicalRequest);

    const credentialScope = `${date}/${env.REGION}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", datetime, credentialScope, hashedCanonicalRequest].join("\n");

    const signingKey = await getSigningKey(env.SECRET_KEY, date, env.REGION, "s3");
    const signature = await hmacSha256(signingKey, stringToSign);
    const signatureHex = bufToHex(signature);

    let expectedSignature = "";
    if (isQueryAuth) {
        expectedSignature = url.searchParams.get("X-Amz-Signature") ?? "";
    } else {
        const authHeader = headers.get("Authorization") ?? "";
        const match = authHeader.match(/Signature=([a-f0-9]+)/);
        expectedSignature = match ? match[1] : "";
    }

    return signatureHex === expectedSignature;
}

async function createCanonicalRequest(request: Request, isQueryAuth: boolean): Promise<string> {
    const url = new URL(request.url);

    const method = request.method;
    const canonicalUri = url.pathname || "/";

    const params = Array.from(url.searchParams.entries())
        .filter(([key]) => key !== "X-Amz-Signature")
        .sort(([a], [b]) => {
            if (a < b) return -1;
            if (a > b) return 1;
            return 0;
        })
        .map(([key, val]) => `${encodeRFC3986(key)}=${encodeRFC3986(val)}`)
        .join("&");

    let signedHeadersList: string[];
    if (isQueryAuth) {
        signedHeadersList = (url.searchParams.get("X-Amz-SignedHeaders") ?? "host").split(";");
    } else {
        const authHeader = request.headers.get("Authorization") ?? "";
        const match = authHeader.match(/SignedHeaders=([^,\s]+)/);
        signedHeadersList = match ? match[1].split(";") : ["host"];
    }

    const canonicalHeaders = signedHeadersList
        .map((h) => {
            const headerName = h.toLowerCase();
            let headerValue = "";

            if (headerName === "host") {
                headerValue = url.hostname;
                const port = url.port;
                if (port && !((url.protocol === "https:" && port === "443") || (url.protocol === "http:" && port === "80"))) {
                    headerValue += `:${port}`;
                }
            } else {
                headerValue = request.headers.get(headerName)?.trim() ?? "";
            }

            return `${headerName}:${headerValue}\n`;
        })
        .join("");

    const signedHeaders = signedHeadersList.join(";");
    const payloadHash = request.headers.get("x-amz-content-sha256") ?? (isQueryAuth ? "UNSIGNED-PAYLOAD" : "UNSIGNED-PAYLOAD");

    return [method, canonicalUri, params, canonicalHeaders, signedHeaders, payloadHash].join("\n");
}

function encodeRFC3986(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function getSigningKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
    const kDate = await hmacSha256("AWS4" + secret, date);
    const kRegion = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, service);
    return await hmacSha256(kService, "aws4_request");
}

async function hmacSha256(key: string | ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const keyData = typeof key === "string" ? new TextEncoder().encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

async function sha256(data: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
    return bufToHex(hash);
}

function bufToHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

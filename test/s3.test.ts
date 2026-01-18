import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AwsClient } from "aws4fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";

const ENV = {
    ACCESS_KEY: "test-access-key",
    SECRET_KEY: "test-secret-key",
    REGION: "auto",
    B2_KEY_ID: "test-b2-key-id",
    B2_APPLICATION_KEY: "test-b2-app-key",
    B2_ENDPOINT: "s3.us-west-000.backblazeb2.com",
    B2_REGION: "us-west-000",
    ALLOWED_BUCKETS: "test-bucket,empty-bucket,my-bucket",
};

const CTX = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
};

const originalFetch = global.fetch;

function createB2MockFetch() {
    return vi.fn(async (url: string | URL | Request, init?: any) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        const urlObj = new URL(urlStr);

        // B2 S3エンドポイントへのリクエストのみ処理
        if (!urlObj.hostname.includes("backblazeb2.com")) {
            return new Response("Not Found", { status: 404 });
        }

        const pathParts = urlObj.pathname.split("/").filter((p) => p);
        const bucket = pathParts[0] || "";
        const objectKey = pathParts.slice(1).join("/");

        const method = init?.method || "GET";

        // PUT (アップロード)
        if (method === "PUT") {
            return new Response(null, {
                status: 200,
                headers: {
                    ETag: '"mock-etag-123"',
                },
            });
        }

        // GET (ダウンロードまたは一覧)
        if (method === "GET") {
            // バケット一覧
            if (!objectKey || objectKey === "") {
                if (bucket === "empty-bucket") {
                    return new Response(
                        `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>${bucket}</Name>
    <Prefix></Prefix>
    <MaxKeys>1000</MaxKeys>
    <IsTruncated>false</IsTruncated>
</ListBucketResult>`,
                        {
                            status: 200,
                            headers: { "Content-Type": "application/xml" },
                        },
                    );
                }

                return new Response(
                    `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
    <Name>${bucket}</Name>
    <Prefix></Prefix>
    <MaxKeys>1000</MaxKeys>
    <IsTruncated>false</IsTruncated>
    <Contents>
        <Key>file1.txt</Key>
        <LastModified>2024-01-01T00:00:00.000Z</LastModified>
        <ETag>"etag1"</ETag>
        <Size>100</Size>
        <StorageClass>STANDARD</StorageClass>
    </Contents>
    <Contents>
        <Key>file2.txt</Key>
        <LastModified>2024-01-02T00:00:00.000Z</LastModified>
        <ETag>"etag2"</ETag>
        <Size>200</Size>
        <StorageClass>STANDARD</StorageClass>
    </Contents>
</ListBucketResult>`,
                    {
                        status: 200,
                        headers: { "Content-Type": "application/xml" },
                    },
                );
            }

            // ファイルダウンロード
            const knownFiles: Record<string, { content: string; contentType: string; size: string }> = {
                "test-file.txt": { content: "Hello World", contentType: "text/plain", size: "11" },
                "dir1/dir2/file.txt": { content: "Nested content", contentType: "text/plain", size: "14" },
                "images/photos/photo.jpg": { content: "Binary image data", contentType: "image/jpeg", size: "17" },
                "test.png": { content: "PNG data", contentType: "image/png", size: "8" },
            };

            const fileInfo = knownFiles[objectKey];
            if (fileInfo) {
                return new Response(fileInfo.content, {
                    status: 200,
                    headers: {
                        "Content-Type": fileInfo.contentType,
                        "Content-Length": fileInfo.size,
                        ETag: '"mock-file-etag"',
                    },
                });
            }

            // 存在しないファイル
            return new Response(
                `<?xml version="1.0" encoding="UTF-8"?>
<Error>
    <Code>NoSuchKey</Code>
    <Message>The specified key does not exist.</Message>
</Error>`,
                { status: 404 },
            );
        }

        // HEAD (メタデータ)
        if (method === "HEAD") {
            const knownFiles: Record<string, { contentType: string; size: string }> = {
                "test-file.txt": { contentType: "text/plain", size: "11" },
                "a/b/c/d/deep.txt": { contentType: "text/plain", size: "999" },
                "docs/archive/old.pdf": { contentType: "application/pdf", size: "54321" },
            };

            const fileInfo = knownFiles[objectKey];
            if (fileInfo) {
                return new Response(null, {
                    status: 200,
                    headers: {
                        "Content-Type": fileInfo.contentType,
                        "Content-Length": fileInfo.size,
                        ETag: '"mock-file-etag"',
                    },
                });
            }

            // 存在しないファイル
            return new Response(null, { status: 404 });
        }

        // DELETE
        if (method === "DELETE") {
            const knownFiles = ["test-file.txt", "docs/archive/old.pdf"];

            if (knownFiles.includes(objectKey)) {
                return new Response(null, { status: 204 });
            }

            // 存在しないファイル
            return new Response(null, { status: 404 });
        }

        return new Response("Method not allowed", { status: 405 });
    }) as any;
}

describe("S3 API Server with Backblaze B2 Backend", () => {
    const endpoint = "https://s3-api.example.com";

    beforeEach(() => {
        vi.clearAllMocks();
        global.fetch = createB2MockFetch();
    });

    // 1. PUT (Upload) テスト
    it("should upload file via PUT with Header Auth", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/test-file.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "PUT",
            headers: {
                "Content-Type": "text/plain",
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
            body: "Hello World",
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toHaveProperty("etag");
    });

    // 2. GET (Download) テスト
    it("should download file via GET with Header Auth", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/test-file.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "GET",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("Hello World");
    });

    // 3. DELETE テスト
    it("should delete file via DELETE", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/test-file.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "DELETE",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(204);
    });

    // 4. HEAD (Metadata) テスト
    it("should get file metadata via HEAD", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/test-file.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "HEAD",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("text/plain");
        expect(response.headers.get("Content-Length")).toBe("11");
    });

    // 5. Presigned URL テスト
    it("should verify presigned URLs from @aws-sdk/s3-request-presigner", async () => {
        const s3 = new S3Client({
            endpoint: `${endpoint}/my-bucket`,
            region: ENV.REGION,
            credentials: {
                accessKeyId: ENV.ACCESS_KEY,
                secretAccessKey: ENV.SECRET_KEY,
            },
        });

        const command = new GetObjectCommand({
            Bucket: "my-bucket",
            Key: "test.png",
        });

        const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
        const parsedUrl = new URL(url);
        const testUrl = new URL(endpoint);
        testUrl.hostname = parsedUrl.hostname;
        testUrl.pathname = parsedUrl.pathname;
        testUrl.search = parsedUrl.search;

        const request = new Request(testUrl.toString(), { method: "GET" });
        const response = await worker.fetch(request, ENV, CTX);
        expect(response.status).toBe(200);
    });

    // 6. 不正な署名のテスト
    it("should reject invalid signatures", async () => {
        const request = new Request(`${endpoint}/hack`, {
            method: "GET",
            headers: {
                Authorization: "AWS4-HMAC-SHA256 Credential=bad/20260108/auto/s3/aws4_request, SignedHeaders=host, Signature=wrong",
                "x-amz-date": "20260108T000000Z",
            },
        });

        const response = await worker.fetch(request, ENV, CTX);
        expect(response.status).toBe(403);
    });

    // 7. バケット一覧テスト (LIST)
    it("should list files in bucket", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "GET",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        const xmlText = await response.text();
        expect(xmlText).toContain("<ListBucketResult");
        expect(xmlText).toContain("file1.txt");
        expect(xmlText).toContain("file2.txt");
    });

    // 8. 存在しないファイルのHEADリクエスト (404)
    it("should return 404 for HEAD on non-existent file", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/non-existent.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "HEAD",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(404);
    });

    // 9. 存在しないファイルのGETリクエスト (404)
    it("should return 404 for GET on non-existent file", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/non-existent.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "GET",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(404);
    });

    // 10. 存在しないファイルのDELETEリクエスト (404)
    it("should return 404 for DELETE on non-existent file", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/non-existent.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "DELETE",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(404);
    });

    // 11. 空のバケット一覧
    it("should return empty list for empty bucket", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/empty-bucket/`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "GET",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        const xmlText = await response.text();
        expect(xmlText).toContain("<ListBucketResult");
        expect(xmlText).not.toContain("<Contents>");
    });

    // 12. ネストされたパスへのアップロード
    it("should upload file to nested path structure", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/dir1/dir2/file.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "PUT",
            headers: {
                "Content-Type": "text/plain",
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
            body: "Nested content",
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(result).toHaveProperty("etag");
    });

    // 13. ネストされたパスからのダウンロード
    it("should download file from nested path structure", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/images/photos/photo.jpg`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "GET",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("image/jpeg");
        expect(await response.text()).toBe("Binary image data");
    });

    // 許可されていないバケットへのアクセス拒否
    it("should reject access to non-allowed buckets", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/forbidden-bucket/test.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "GET",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(403);
        expect(await response.text()).toBe("Access denied to this bucket");
    });
});

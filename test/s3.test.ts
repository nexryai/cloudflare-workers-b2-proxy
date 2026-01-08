import { describe, it, expect, vi } from "vitest";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { AwsClient } from "aws4fetch";
import worker from "../src/index";

const ENV = {
    ACCESS_KEY: "test-access-key",
    SECRET_KEY: "test-secret-key",
    REGION: "auto",
};

const CTX = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
};

describe("S3 API Server Authentication", () => {
    const endpoint = "https://s3-api.example.com";

    it("should verify requests from aws4fetch (Header Auth)", async () => {
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
            body: "hello world",
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Verified PUT");
    });

    it("should verify presigned URLs from @aws-sdk/s3-request-presigner", async () => {
        const s3 = new S3Client({
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

        console.log("Presigned URL:", url);

        const parsedUrl = new URL(url);

        const testUrl = new URL(endpoint);
        testUrl.hostname = parsedUrl.hostname;
        testUrl.pathname = parsedUrl.pathname;
        testUrl.search = parsedUrl.search;

        const request = new Request(testUrl.toString(), { method: "GET" });
        const response = await worker.fetch(request, ENV, CTX);

        expect(response.status).toBe(200);
        expect(await response.text()).toContain("Verified GET");
    });

    it("should verify requests from aws4fetch with query parameters", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/aws4-fetch-test`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "GET",
            aws: { signQuery: true }, // クエリパラメータ署名
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(200);
    });

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

    // 5. DELETE メソッドのテスト
    it("should verify DELETE requests", async () => {
        const aws4 = new AwsClient({
            accessKeyId: ENV.ACCESS_KEY,
            secretAccessKey: ENV.SECRET_KEY,
            region: ENV.REGION,
            service: "s3",
        });

        const requestUrl = `${endpoint}/test-bucket/file-to-delete.txt`;
        const signedReq = await aws4.sign(requestUrl, {
            method: "DELETE",
            headers: {
                "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
            },
        });

        const response = await worker.fetch(signedReq, ENV, CTX);
        expect(response.status).toBe(204);
    });
});

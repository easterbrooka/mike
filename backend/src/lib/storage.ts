/**
 * S3-compatible storage utilities for Mike document management.
 * Works with either Cloudflare R2 or AWS S3 — both use @aws-sdk/client-s3.
 *
 * Env vars:
 *   R2_BUCKET_NAME       — bucket name (default: "mike")
 *   R2_REGION            — AWS region (e.g. ap-southeast-2). Falls back to
 *                          AWS_REGION (auto-set inside ECS) and finally "auto"
 *                          which is required for R2.
 *   R2_ENDPOINT_URL      — optional. Set for R2 (https://<acct>.r2.cloudflarestorage.com)
 *                          or local minio. Leave unset for AWS S3.
 *   R2_ACCESS_KEY_ID     — optional. If unset, the SDK's default credential
 *   R2_SECRET_ACCESS_KEY   provider chain is used (picks up the ECS task role
 *                          when running on AWS).
 *   KMS_KEY_ID           — optional. When set, every PutObject is sent with
 *                          ServerSideEncryption=aws:kms + this key ID, which
 *                          gives CloudTrail audit logging on every Decrypt.
 *                          When unset, falls back to ServerSideEncryption=AES256
 *                          (SSE-S3) which is supported by both AWS S3 and
 *                          Cloudflare R2 with no extra config.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl as awsGetSignedUrl } from "@aws-sdk/s3-request-presigner";

function getClient(): S3Client {
  const endpoint = process.env.R2_ENDPOINT_URL;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const region = process.env.R2_REGION ?? process.env.AWS_REGION ?? "auto";

  return new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(accessKeyId && secretAccessKey
      ? { credentials: { accessKeyId, secretAccessKey } }
      : {}),
  });
}

const BUCKET = process.env.R2_BUCKET_NAME ?? "mike";

const hasExplicitCreds = Boolean(
  process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY,
);
const hasAwsRegion = Boolean(process.env.AWS_REGION ?? process.env.R2_REGION);

export const storageEnabled = hasExplicitCreds || hasAwsRegion;

/**
 * Build the SSE arguments to pass alongside every PutObjectCommand.
 * Returns either {ServerSideEncryption: "aws:kms", SSEKMSKeyId: ...} when
 * KMS_KEY_ID is set, or {ServerSideEncryption: "AES256"} otherwise.
 *
 * Setting these on every put removes any reliance on bucket-default
 * encryption staying correctly configured — a misconfiguration there
 * would silently start storing plaintext on disk.
 */
function sseArgs(): {
  ServerSideEncryption: "aws:kms" | "AES256";
  SSEKMSKeyId?: string;
} {
  const kmsKeyId = process.env.KMS_KEY_ID;
  if (kmsKeyId) {
    return { ServerSideEncryption: "aws:kms", SSEKMSKeyId: kmsKeyId };
  }
  return { ServerSideEncryption: "AES256" };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export async function uploadFile(
  key: string,
  content: ArrayBuffer,
  contentType: string,
): Promise<void> {
  const client = getClient();
  await client.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: Buffer.from(content),
      ContentType: contentType,
      ...sseArgs(),
    }),
  );
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

export async function downloadFile(key: string): Promise<ArrayBuffer | null> {
  if (!storageEnabled) return null;
  try {
    const client = getClient();
    const response = await client.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    );
    if (!response.Body) return null;
    const bytes = await response.Body.transformToByteArray();
    return bytes.buffer as ArrayBuffer;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deleteFile(key: string): Promise<void> {
  if (!storageEnabled) return;
  const client = getClient();
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

// ---------------------------------------------------------------------------
// Signed URL (pre-signed for temporary direct access)
// ---------------------------------------------------------------------------

export async function getSignedUrl(
  key: string,
  expiresIn = 3600,
  downloadFilename?: string,
): Promise<string | null> {
  if (!storageEnabled) return null;
  try {
    const client = getClient();
    // Override the response Content-Disposition so the browser uses this
    // filename on download, instead of the last path segment of the R2 key
    // (which includes the document UUID). The `download` attribute on <a>
    // is ignored for cross-origin URLs, so we have to set it server-side.
    const responseContentDisposition = downloadFilename
      ? buildContentDisposition("attachment", downloadFilename)
      : undefined;
    const command = new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ResponseContentDisposition: responseContentDisposition,
    });
    return await awsGetSignedUrl(client, command, { expiresIn });
  } catch {
    return null;
  }
}

export function normalizeDownloadFilename(name: string): string {
  const trimmed = name.trim();
  const base = trimmed || "download";
  return base.replace(/[\x00-\x1F\x7F]/g, "_").replace(/[\\/]/g, "_");
}

export function sanitizeDispositionFilename(name: string): string {
  return normalizeDownloadFilename(name).replace(/["\\]/g, "_");
}

export function encodeRFC5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

export function buildContentDisposition(
  kind: "inline" | "attachment",
  filename: string,
): string {
  const normalized = normalizeDownloadFilename(filename);
  return `${kind}; filename="${sanitizeDispositionFilename(normalized)}"; filename*=UTF-8''${encodeRFC5987(normalized)}`;
}

// ---------------------------------------------------------------------------
// Storage key helpers
// ---------------------------------------------------------------------------

export function storageKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/source${storageExtension(filename, ".bin")}`;
}

export function pdfStorageKey(
  userId: string,
  docId: string,
  stem: string,
): string {
  return `documents/${userId}/${docId}/${stem}.pdf`;
}

export function generatedDocKey(
  userId: string,
  docId: string,
  filename: string,
): string {
  return `generated/${userId}/${docId}/generated${storageExtension(filename, ".docx")}`;
}

export function versionStorageKey(
  userId: string,
  docId: string,
  versionSlug: string,
  filename: string,
): string {
  return `documents/${userId}/${docId}/versions/${versionSlug}${storageExtension(filename, ".bin")}`;
}

function storageExtension(filename: string, fallback: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot < 0) return fallback;
  const ext = filename.slice(lastDot).toLowerCase();
  return /^\.[a-z0-9]{1,16}$/.test(ext) ? ext : fallback;
}

import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface PresignedUpload {
  url: string;
  method: "PUT";
  /** Headers the browser must send with the PUT (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

/**
 * Where attachment bytes live. Uploads go straight from the browser to storage with a short-lived
 * presigned URL, so files never pass through the API container or CloudFront.
 */
export interface AttachmentStore {
  /** Origin the browser uploads to (added to the CSP `connect-src`); null when uploads stay same-origin. */
  readonly uploadOrigin: string | null;
  presignUpload(key: string, contentType: string, expiresSeconds?: number): Promise<PresignedUpload>;
  head(key: string): Promise<{ size: number; contentType: string | null; lastModified: string | null } | null>;
  get(key: string): Promise<Buffer>;
  /** Deletes one object (a delete marker on the versioned bucket). */
  delete(key: string): Promise<void>;
  /** Deletes every object under the prefix; returns how many were deleted. */
  deletePrefix(prefix: string): Promise<number>;
}

export class S3AttachmentStore implements AttachmentStore {
  private readonly client: S3Client;
  readonly uploadOrigin: string;

  constructor(region: string, private readonly bucket: string) {
    this.client = new S3Client({ region });
    // Virtual-hosted-style URL, which is what the presigner produces for bucket names without dots.
    this.uploadOrigin = `https://${bucket}.s3.${region}.amazonaws.com`;
  }

  async presignUpload(key: string, contentType: string, expiresSeconds = 900): Promise<PresignedUpload> {
    // The bucket's default encryption (SSE-KMS with the PHI key) applies to the PUT; the signer (task role)
    // holds the KMS permission, so the browser needs no encryption headers.
    const url = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType }), { expiresIn: expiresSeconds });
    return { url, method: "PUT", headers: { "content-type": contentType }, expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString() };
  }

  async head(key: string): Promise<{ size: number; contentType: string | null; lastModified: string | null } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: r.ContentLength ?? 0, contentType: r.ContentType ?? null, lastModified: r.LastModified ? r.LastModified.toISOString() : null };
    } catch (e) {
      const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === "NotFound" || err.name === "NoSuchKey" || err.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!r.Body) throw new Error("empty object body");
    return Buffer.from(await r.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deletePrefix(prefix: string): Promise<number> {
    let token: string | undefined;
    let deleted = 0;
    do {
      const r = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      const keys = (r.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length > 0) {
        // The bucket is versioned: this writes delete markers; older versions expire via the lifecycle rule.
        await this.client.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }));
        deleted += keys.length;
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
}

/** In-memory store for development and tests. Uploads go to a dev-only route on the API itself. */
export class MemoryAttachmentStore implements AttachmentStore {
  readonly uploadOrigin = null;
  readonly objects = new Map<string, { body: Buffer; contentType: string; lastModified: string }>();

  async presignUpload(key: string, contentType: string, expiresSeconds = 900): Promise<PresignedUpload> {
    return {
      url: `/api/dev/upload/${key.split("/").map(encodeURIComponent).join("/")}`,
      method: "PUT",
      headers: { "content-type": contentType },
      expiresAt: new Date(Date.now() + expiresSeconds * 1000).toISOString(),
    };
  }

  put(key: string, body: Buffer, contentType: string): void {
    this.objects.set(key, { body, contentType, lastModified: new Date().toISOString() });
  }

  async head(key: string): Promise<{ size: number; contentType: string | null; lastModified: string | null } | null> {
    const o = this.objects.get(key);
    return o ? { size: o.body.length, contentType: o.contentType, lastModified: o.lastModified } : null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async get(key: string): Promise<Buffer> {
    const o = this.objects.get(key);
    if (!o) throw new Error(`attachment not found: ${key}`);
    return o.body;
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.objects.keys()]) {
      if (k.startsWith(prefix)) { this.objects.delete(k); n++; }
    }
    return n;
  }
}

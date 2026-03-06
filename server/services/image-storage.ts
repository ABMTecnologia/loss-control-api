import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Storage } from "@google-cloud/storage";

type UploadInput = {
  companyId: string;
  userId: string;
  lossEventId: string;
  mimeType: string;
  originalFileName: string;
  buffer: Buffer;
};

type UploadResult = {
  storageKey: string;
  url: string;
};

const extByMime: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function buildKey(input: UploadInput) {
  const ext = (extByMime[input.mimeType] ?? path.extname(input.originalFileName)) || ".bin";
  const fileName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  return `${input.companyId}/${input.userId}/loss-events/${input.lossEventId}/${fileName}`;
}

let gcs: Storage | null = null;
function getGcs() {
  if (!gcs) gcs = new Storage();
  return gcs;
}

export async function uploadLossEventImage(input: UploadInput): Promise<UploadResult> {
  const bucketName = (process.env.STORAGE_IMAGE ?? "").trim();
  const key = buildKey(input);

  if (!bucketName) {
    const dir = path.join(process.cwd(), "uploads", path.dirname(key));
    await mkdir(dir, { recursive: true });
    const absPath = path.join(process.cwd(), "uploads", key);
    await writeFile(absPath, input.buffer);
    return {
      storageKey: key,
      url: `/uploads/${key}`,
    };
  }

  const bucket = getGcs().bucket(bucketName);
  const file = bucket.file(key);
  await file.save(input.buffer, {
    resumable: false,
    contentType: input.mimeType,
    metadata: { contentType: input.mimeType },
  });

  const publicBase = (process.env.STORAGE_PUBLIC_BASE_URL ?? "").trim();
  const url = publicBase
    ? `${publicBase.replace(/\/$/, "")}/${key}`
    : `https://storage.googleapis.com/${bucketName}/${key}`;

  return { storageKey: key, url };
}

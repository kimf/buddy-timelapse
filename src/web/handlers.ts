import { IncomingMessage, ServerResponse } from "http";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { spawn } from "child_process";
import { PrusaLinkClient } from "../api/client";
import { AppConfig } from "../types/config";
import { MonitorState } from "../monitor";
import { HLS_DIR, getStreamManager } from "./stream";

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export function serveJSON(res: ServerResponse, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

export function serveError(
  res: ServerResponse,
  code: number,
  message: string
): void {
  if (!res.headersSent) {
    res.writeHead(code, { "Content-Type": "text/plain" });
    res.end(message);
  }
}

export function serveStatic(res: ServerResponse, filePath: string): void {
  if (!existsSync(filePath)) {
    serveError(res, 404, "Not found");
    return;
  }
  const typeMap: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js":   "application/javascript",
    ".css":  "text/css",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".ts":   "application/javascript", // .ts segments served by HLS
    ".m3u8": "application/vnd.apple.mpegurl",
  };
  const ext = extname(filePath);
  const contentType = typeMap[ext] ?? "application/octet-stream";
  // Vite hashes asset filenames → long cache; index.html and HLS files are not hashed
  const isImmutable = filePath.includes("/assets/");
  const data = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": isImmutable
      ? "public, max-age=31536000, immutable"
      : "no-store",
  });
  res.end(data);
}

// ---------------------------------------------------------------------------
// Printer status
// ---------------------------------------------------------------------------

export async function handleStatus(
  res: ServerResponse,
  config: AppConfig,
  getMonitorState?: () => MonitorState
): Promise<void> {
  const client = new PrusaLinkClient(config.prusaLink);
  try {
    const status = await client.getStatus();
    const payload: Record<string, unknown> = { ...status };
    if (getMonitorState) {
      payload.monitorState = getMonitorState();
    }
    serveJSON(res, payload);
  } catch (err) {
    serveError(res, 502, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Camera snapshot
// ---------------------------------------------------------------------------

export async function handleCameraSnapshot(
  res: ServerResponse,
  config: AppConfig
): Promise<void> {
  return new Promise((done) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-rtsp_transport", "tcp",
        "-i", config.timelapse.rtspUrl,
        "-vframes", "1",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    const chunks: Buffer[] = [];
    ffmpeg.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));

    ffmpeg.on("exit", (code) => {
      if (code === 0 && chunks.length > 0) {
        const data = Buffer.concat(chunks);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": data.length,
          "Cache-Control": "no-store",
        });
        res.end(data);
      } else {
        serveError(res, 503, "Camera unavailable");
      }
      done();
    });

    ffmpeg.on("error", () => {
      serveError(res, 503, "ffmpeg not found");
      done();
    });
  });
}

// ---------------------------------------------------------------------------
// HLS live stream
// ---------------------------------------------------------------------------

export async function handleStreamStart(
  res: ServerResponse,
  config: AppConfig
): Promise<void> {
  const manager = getStreamManager(config.timelapse.rtspUrl);
  try {
    const url = await manager.start();
    serveJSON(res, { url });
  } catch (err) {
    serveError(res, 503, `Failed to start stream: ${(err as Error).message}`);
  }
}

export function handleStreamStop(
  res: ServerResponse,
  config: AppConfig
): void {
  getStreamManager(config.timelapse.rtspUrl).stop();
  res.writeHead(204);
  res.end();
}

export function handleHlsFile(res: ServerResponse, filename: string): void {
  const safeName = basename(filename);
  serveStatic(res, join(HLS_DIR, safeName));
}

// ---------------------------------------------------------------------------
// Video list + thumbnails
// ---------------------------------------------------------------------------

export function handleVideoList(res: ServerResponse, config: AppConfig): void {
  const dir = resolve(config.timelapse.outputDirectory);
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".mp4"))
      .map((f) => {
        const stat = statSync(join(dir, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
    serveJSON(res, files);
  } catch {
    serveJSON(res, []);
  }
}

export async function handleVideoThumbnail(
  res: ServerResponse,
  config: AppConfig,
  rawName: string
): Promise<void> {
  const safeName = basename(rawName);
  const videoPath = join(resolve(config.timelapse.outputDirectory), safeName);

  if (!existsSync(videoPath) || !safeName.endsWith(".mp4")) {
    serveError(res, 404, "Not found");
    return;
  }

  // Serve pre-generated thumbnail if it exists
  const thumbPath = videoPath.replace(/\.mp4$/i, ".thumb.jpg");
  if (existsSync(thumbPath)) {
    const data = readFileSync(thumbPath);
    res.writeHead(200, {
      "Content-Type": "image/jpeg",
      "Content-Length": data.length,
      "Cache-Control": "public, max-age=86400",
    });
    res.end(data);
    return;
  }

  // Fallback: generate on-the-fly
  return new Promise((done) => {
    const ffmpeg = spawn(
      "ffmpeg",
      [
        "-sseof", "-1",
        "-i", videoPath,
        "-vframes", "1",
        "-vf", "scale=320:-1",
        "-f", "image2pipe",
        "-vcodec", "mjpeg",
        "pipe:1",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    const chunks: Buffer[] = [];
    ffmpeg.stdout!.on("data", (chunk: Buffer) => chunks.push(chunk));

    ffmpeg.on("exit", (code) => {
      if (code === 0 && chunks.length > 0) {
        const data = Buffer.concat(chunks);
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": data.length,
          "Cache-Control": "public, max-age=3600",
        });
        res.end(data);
      } else {
        serveError(res, 503, "Thumbnail unavailable");
      }
      done();
    });

    ffmpeg.on("error", () => {
      serveError(res, 503, "ffmpeg not found");
      done();
    });
  });
}

export function handleVideoFile(
  req: IncomingMessage,
  res: ServerResponse,
  config: AppConfig,
  rawName: string
): void {
  const safeName = basename(rawName);
  const videoPath = join(resolve(config.timelapse.outputDirectory), safeName);

  if (!existsSync(videoPath) || !safeName.endsWith(".mp4")) {
    serveError(res, 404, "Not found");
    return;
  }

  const { size } = statSync(videoPath);
  const rangeHeader = typeof req.headers["range"] === "string" ? req.headers["range"] : undefined;

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : size - 1;

    // Validate bounds
    if (isNaN(start) || isNaN(end) || start > end || start >= size || end >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }

    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Cache-Control": "no-store",
    });
    const rangeStream = createReadStream(videoPath, { start, end });
    rangeStream.on("error", () => serveError(res, 500, "Read error"));
    rangeStream.pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": size,
      "Cache-Control": "no-store",
    });
    const fileStream = createReadStream(videoPath);
    fileStream.on("error", () => serveError(res, 500, "Read error"));
    fileStream.pipe(res);
  }
}

// ---------------------------------------------------------------------------
// Recovered frames list + thumbnails
// ---------------------------------------------------------------------------

export function handleRecoveredList(
  res: ServerResponse,
  config: AppConfig
): void {
  const base = join(resolve(config.timelapse.tempDirectory), "recovered");
  try {
    const dirs = readdirSync(base)
      .filter((d) => statSync(join(base, d)).isDirectory())
      .map((d) => {
        const frames = readdirSync(join(base, d)).filter(
          (f) => f.startsWith("img_") && f.endsWith(".jpg")
        );
        return { name: d, frameCount: frames.length };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
    serveJSON(res, dirs);
  } catch {
    serveJSON(res, []);
  }
}

export function handleRecoveredThumbnail(
  res: ServerResponse,
  config: AppConfig,
  rawName: string
): void {
  const safeName = basename(rawName);
  const framePath = join(
    resolve(config.timelapse.tempDirectory),
    "recovered",
    safeName,
    "img_00001.jpg"
  );

  if (!existsSync(framePath)) {
    serveError(res, 404, "No frames found");
    return;
  }

  const data = readFileSync(framePath);
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": data.length,
    "Cache-Control": "public, max-age=3600",
  });
  res.end(data);
}

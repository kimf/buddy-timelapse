import { ChildProcess, spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export const HLS_DIR = join(tmpdir(), "prusa-timelapse-hls");

// Players re-fetch the playlist every segment (~2 s); this long without a request means nobody is watching.
const IDLE_STOP_MS = 30_000;

export class HlsStreamManager {
  private process: ChildProcess | null = null;
  private lastRequest = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly rtspUrl: string,
    private readonly hlsDir: string
  ) {}

  async start(): Promise<string> {
    // Already running — return the existing URL immediately
    if (this.process) {
      return "/api/camera/hls/stream.m3u8";
    }

    // Clean slate
    if (existsSync(this.hlsDir)) {
      rmSync(this.hlsDir, { recursive: true, force: true });
    }
    mkdirSync(this.hlsDir, { recursive: true });

    this.process = spawn(
      "ffmpeg",
      [
        "-timeout", "10000000",
        "-rtsp_transport", "tcp",
        "-i", this.rtspUrl,
        // The camera already sends H.264, so remux instead of re-encoding (~10% CPU instead of ~150% on a Pi 4).
        // Segments can only start at keyframes, which the camera sends every ~2.3 s.
        "-c:v", "copy",
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "5",
        "-hls_flags", "delete_segments",
        "-hls_segment_filename", join(this.hlsDir, "seg%d.ts"),
        join(this.hlsDir, "stream.m3u8"),
      ],
      { stdio: "ignore" }
    );

    this.touch();
    this.idleTimer ??= setInterval(() => {
      if (Date.now() - this.lastRequest > IDLE_STOP_MS) this.stop();
    }, 5_000);

    this.process.on("exit", () => {
      this.process = null;
    });

    this.process.on("error", (err) => {
      console.error(`HLS stream error: ${err.message}`);
      this.process = null;
    });

    await this.waitForFile(join(this.hlsDir, "stream.m3u8"), 15_000);
    return "/api/camera/hls/stream.m3u8";
  }

  stop(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    try {
      if (existsSync(this.hlsDir)) {
        rmSync(this.hlsDir, { recursive: true, force: true });
      }
    } catch {
      // Non-fatal
    }
  }

  touch(): void {
    this.lastRequest = Date.now();
  }

  isStreaming(): boolean {
    return this.process !== null;
  }

  private waitForFile(filePath: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (existsSync(filePath)) return resolve();
        if (Date.now() > deadline) {
          return reject(new Error("Timed out waiting for HLS stream to start"));
        }
        setTimeout(check, 250);
      };
      check();
    });
  }
}

// Module-level singleton — one stream shared across all requests
let _manager: HlsStreamManager | null = null;

export function getStreamManager(rtspUrl: string): HlsStreamManager {
  if (!_manager) {
    _manager = new HlsStreamManager(rtspUrl, HLS_DIR);
  }
  return _manager;
}

export function touchStream(): void {
  _manager?.touch();
}

import { ChildProcess, spawn } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export const HLS_DIR = join(tmpdir(), "prusa-timelapse-hls");

export class HlsStreamManager {
  private process: ChildProcess | null = null;

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
        "-rtsp_transport", "tcp",
        "-i", this.rtspUrl,
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-f", "hls",
        "-hls_time", "2",
        "-hls_list_size", "5",
        "-hls_flags", "delete_segments+split_by_time",
        "-hls_segment_filename", join(this.hlsDir, "seg%d.ts"),
        join(this.hlsDir, "stream.m3u8"),
      ],
      { stdio: "ignore" }
    );

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

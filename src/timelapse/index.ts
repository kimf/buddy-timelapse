import { ChildProcess, spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { TimelapseConfig } from "../types/config";

export class TimelapseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimelapseError";
  }
}

/**
 * Persisted state for an active timelapse capture session.
 * Written to `capture-state.json` in the temp directory so the monitor
 * can resume the same timelapse after a server restart or crash.
 */
export interface CaptureState {
  /** PrusaLink job ID that this capture session belongs to. */
  jobId: number;
  /** Number of frames captured so far (used to resume frame numbering). */
  frameCount: number;
  /** ISO timestamp of when capture originally started. */
  startedAt: string;
}

/** Filename for the persisted capture state, stored in the temp directory. */
const CAPTURE_STATE_FILENAME = "capture-state.json";

export class TimelapseCapture {
  private config: TimelapseConfig;
  private captureProcess: ChildProcess | null = null;
  private tempDir: string;
  private isCapturing = false;

  constructor(config: TimelapseConfig) {
    this.config = config;
    this.tempDir = resolve(this.config.tempDirectory);
  }

  async startCapture(startNumber: number = 1): Promise<void> {
    if (this.isCapturing) {
      throw new TimelapseError("Capture already in progress");
    }

    // Ensure temp directory exists
    try {
      mkdirSync(this.tempDir, { recursive: true });
    } catch (error) {
      throw new TimelapseError(
        `Failed to create temp directory: ${(error as Error).message}`
      );
    }

    // Move any orphaned frames from a previous crashed run to a recovery directory
    this.rescueOrphanedFrames();

    // Start ffmpeg capture process
    const outputPattern = join(this.tempDir, "img_%05d.jpg");
    const interval = this.config.captureInterval;

    // ffmpeg command: ffmpeg -rtsp_transport tcp -i {rtspUrl} -vf fps=1/{interval} [-start_number N] -y {outputPattern}
    const ffmpegArgs = [
      "-rtsp_transport",
      "tcp",
      "-i",
      this.config.rtspUrl,
      "-vf",
      `fps=1/${interval}`,
    ];

    if (startNumber > 1) {
      ffmpegArgs.push("-start_number", startNumber.toString());
    }

    ffmpegArgs.push("-y", outputPattern);

    this.captureProcess = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.isCapturing = true;

    // Handle process events
    this.captureProcess.on("error", (error) => {
      this.isCapturing = false;
      console.error(`ffmpeg capture error: ${error.message}`);
    });

    this.captureProcess.on("exit", (code, signal) => {
      this.isCapturing = false;
      if (code !== 0 && code !== null) {
        console.error(`ffmpeg capture exited with code ${code}`);
      }
    });

    // Log ffmpeg output for debugging
    if (this.captureProcess.stdout) {
      this.captureProcess.stdout.on("data", (data) => {
        console.log(`ffmpeg stdout: ${data}`);
      });
    }

    if (this.captureProcess.stderr) {
      this.captureProcess.stderr.on("data", (data) => {
        console.log(`ffmpeg stderr: ${data}`);
      });
    }
  }

  async stopCapture(): Promise<void> {
    if (!this.isCapturing || !this.captureProcess) {
      return;
    }

    this.captureProcess.kill("SIGTERM");

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      if (this.captureProcess) {
        this.captureProcess.on("exit", () => {
          this.isCapturing = false;
          this.captureProcess = null;
          resolve();
        });

        // Force kill after 5 seconds
        setTimeout(() => {
          if (this.captureProcess) {
            this.captureProcess.kill("SIGKILL");
          }
          this.isCapturing = false;
          this.captureProcess = null;
          resolve();
        }, 5000);
      } else {
        resolve();
      }
    });
  }

  isCurrentlyCapturing(): boolean {
    return this.isCapturing;
  }

  private rescueOrphanedFrames(): void {
    try {
      const files = readdirSync(this.tempDir);
      const frames = files.filter(
        (f) => f.startsWith("img_") && f.endsWith(".jpg")
      );
      if (frames.length === 0) return;

      const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, -5);
      const recoveryDir = join(this.tempDir, "recovered", timestamp);
      mkdirSync(recoveryDir, { recursive: true });

      for (const file of frames) {
        renameSync(join(this.tempDir, file), join(recoveryDir, file));
      }

      console.warn(
        `Rescued ${frames.length} orphaned frames to: ${recoveryDir}`
      );
    } catch (error) {
      // Non-fatal: log and continue so capture can still start
      console.error(
        `Failed to rescue orphaned frames: ${(error as Error).message}`
      );
    }
  }

  getCapturedFrameCount(): number {
    try {
      const files = readdirSync(this.tempDir);
      return files.filter(
        (file) => file.startsWith("img_") && file.endsWith(".jpg")
      ).length;
    } catch (error) {
      return 0;
    }
  }

  /**
   * Persist the current capture state to disk so it survives server restarts.
   * Written on capture start and on capture stop (pause or finish).
   */
  writeCaptureState(jobId: number, frameCount: number, startedAt: string): void {
    const state: CaptureState = { jobId, frameCount, startedAt };
    const statePath = join(this.tempDir, CAPTURE_STATE_FILENAME);
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error(`Failed to write capture state: ${(error as Error).message}`);
    }
  }

  /**
   * Read the persisted capture state from disk.
   * Returns null if no state file exists, or if the file is corrupt/unreadable.
   */
  readCaptureState(): CaptureState | null {
    const statePath = join(this.tempDir, CAPTURE_STATE_FILENAME);
    try {
      if (!existsSync(statePath)) return null;
      const raw = readFileSync(statePath, "utf-8");
      const state = JSON.parse(raw) as CaptureState;
      // Basic validation: ensure required fields exist
      if (typeof state.jobId !== "number" || typeof state.frameCount !== "number") {
        console.warn("Capture state file has invalid format, ignoring");
        return null;
      }
      return state;
    } catch (error) {
      console.warn(`Failed to read capture state: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Delete the capture state file from disk.
   * Called after successful video assembly or when frames are moved to recovered.
   */
  deleteCaptureState(): void {
    const statePath = join(this.tempDir, CAPTURE_STATE_FILENAME);
    try {
      if (existsSync(statePath)) unlinkSync(statePath);
    } catch (error) {
      console.error(`Failed to delete capture state: ${(error as Error).message}`);
    }
  }

  /**
   * Remove all captured frames (img_*.jpg) from the temp directory.
   * Called after successful video assembly to keep the temp directory clean.
   */
  cleanupFrames(): void {
    try {
      const files = readdirSync(this.tempDir);
      const frames = files.filter(
        (f) => f.startsWith("img_") && f.endsWith(".jpg")
      );
      for (const file of frames) {
        unlinkSync(join(this.tempDir, file));
      }
      if (frames.length > 0) {
        console.log(`Cleaned up ${frames.length} frames from temp directory`);
      }
    } catch (error) {
      console.error(`Failed to clean up frames: ${(error as Error).message}`);
    }
  }
}

export async function assembleVideo(
  config: TimelapseConfig,
  outputPath: string
): Promise<void> {
  const tempDir = resolve(config.tempDirectory);
  const inputPattern = join(tempDir, "img_%05d.jpg");

  // Ensure output directory exists
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
  } catch (error) {
    throw new TimelapseError(
      `Failed to create output directory: ${(error as Error).message}`
    );
  }

  return new Promise((resolve, reject) => {
    // Check if we have any frames to assemble
    const capture = new TimelapseCapture(config);
    const frameCount = capture.getCapturedFrameCount();

    if (frameCount === 0) {
      reject(new TimelapseError("No frames captured to assemble video"));
      return;
    }

    // ffmpeg command: ffmpeg -framerate {framerate} -i {inputPattern} -c:v libx264 -pix_fmt yuv420p {outputPath}
    const ffmpegArgs = [
      "-framerate",
      config.outputFramerate.toString(),
      "-i",
      inputPattern,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-y", // Overwrite output file
      outputPath,
    ];

    const assembleProcess = spawn("ffmpeg", ffmpegArgs, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    if (assembleProcess.stdout) {
      assembleProcess.stdout.on("data", (data) => {
        stdout += data;
      });
    }

    if (assembleProcess.stderr) {
      assembleProcess.stderr.on("data", (data) => {
        stderr += data;
      });
    }

    assembleProcess.on("error", (error) => {
      reject(new TimelapseError(`ffmpeg assemble error: ${error.message}`));
    });

    assembleProcess.on("exit", (code, signal) => {
      if (code === 0) {
        console.log(`Video assembled successfully: ${outputPath}`);
        // Generate a thumbnail next to the video
        const thumbPath = outputPath.replace(/\.mp4$/i, ".thumb.jpg");
        generateThumbnail(outputPath, thumbPath).then(
          () => console.log(`Thumbnail saved: ${thumbPath}`),
          (err) => console.warn(`Thumbnail generation failed: ${err.message}`)
        );
        resolve();
      } else {
        reject(
          new TimelapseError(
            `ffmpeg assemble failed with code ${code}. stderr: ${stderr}`
          )
        );
      }
    });
  });
}

/** Extract a single frame from a video and save as a JPEG thumbnail. */
function generateThumbnail(
  videoPath: string,
  thumbPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-sseof", "-1",
      "-i", videoPath,
      "-vframes", "1",
      "-vf", "scale=320:-1",
      "-y",
      thumbPath,
    ], { stdio: ["ignore", "ignore", "ignore"] });

    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit code ${code}`))
    );
    proc.on("error", reject);
  });
}

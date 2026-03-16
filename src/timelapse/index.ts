import { ChildProcess, spawn } from "child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
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

/**
 * Manages the ffmpeg capture process that grabs frames from the printer
 * camera over RTSP and writes them as sequentially numbered JPEG files.
 *
 * ## Capture lifecycle
 *
 * 1. **start** — `startCapture()` spawns an ffmpeg process that continuously
 *    pulls frames from the RTSP stream and writes them as
 *    `img_00001.jpg`, `img_00002.jpg`, … into the temp directory.
 * 2. **frames accumulate** — ffmpeg runs until `stopCapture()` is called.
 *    The printer may be paused mid-print; in that case the capture process
 *    is stopped and restarted later with a `startNumber` offset so
 *    numbering stays contiguous.
 * 3. **stop** — `stopCapture()` sends SIGTERM to ffmpeg and waits up to 5 s
 *    for a graceful exit before escalating to SIGKILL.
 * 4. **assemble** — the standalone `assembleVideo()` function consumes all
 *    `img_*.jpg` files and produces the final MP4.
 * 5. **archive** — `archiveFrames(printId)` moves the JPEG files to a
 *    `finished/{printId}/` subdirectory after a successful assembly.
 *
 * ## Temp directory structure
 *
 * ```
 * {tempDirectory}/
 *   img_00001.jpg          ← captured frames (named by ffmpeg)
 *   img_00002.jpg
 *   …
 *   capture-state.json     ← persisted CaptureState (written by this class)
 *   recovered/             ← orphaned frames from previous crashed sessions
 *     2024-01-15T10-30-00/
 *       img_00001.jpg
 * ```
 *
 * ## State file
 *
 * `capture-state.json` is written on every capture start and on every
 * pause/stop so the monitor can resume after a server restart without
 * losing already-captured frames or messing up frame numbering.
 */
export class TimelapseCapture {
  private config: TimelapseConfig;
  private captureProcess: ChildProcess | null = null;
  private tempDir: string;
  private isCapturing = false;

  constructor(config: TimelapseConfig) {
    this.config = config;
    this.tempDir = resolve(this.config.tempDirectory);
  }

  /**
   * Start the ffmpeg frame-capture process.
   *
   * ffmpeg is invoked with the pattern:
   * ```
   * ffmpeg -rtsp_transport tcp -i {rtspUrl} -vf fps=1/{interval} [-start_number N] -y img_%05d.jpg
   * ```
   *
   * The `-start_number` flag is passed only when `startNumber > 1` so that
   * frames written in this session continue the numbering from where the
   * previous session left off. This is critical for resume: if a capture
   * was interrupted at frame 150, passing `startNumber = 151` makes ffmpeg
   * begin writing `img_00151.jpg`, keeping the sequence contiguous for
   * `assembleVideo()`.
   *
   * @param startNumber - First frame number to use (1-based). Pass `1` for
   *   a brand-new capture, or `existingFrameCount + 1` when resuming after
   *   a pause or crash. Defaults to `1`.
   * @throws {TimelapseError} If a capture is already in progress, or if the
   *   temp directory cannot be created.
   */
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

  /**
   * Stop the running ffmpeg capture process gracefully.
   *
   * Sends SIGTERM to allow ffmpeg to flush any partially-written frame and
   * exit cleanly. If ffmpeg has not exited within 5 seconds, SIGKILL is
   * sent to ensure the process is terminated regardless.
   *
   * This method is a no-op if no capture is currently running.
   */
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

  /**
   * Returns `true` if an ffmpeg capture process is currently running.
   *
   * This reflects the in-process state flag, not whether the ffmpeg binary
   * is actually alive on the OS. The flag is set to `false` when the process
   * exits or errors, so it stays accurate under normal operation.
   */
  isCurrentlyCapturing(): boolean {
    return this.isCapturing;
  }

  /**
   * Move orphaned frames from a previous crashed capture run to a
   * timestamped recovery directory. This prevents old frames from being
   * mixed into a new capture session.
   *
   * Frames are moved to: {tempDir}/recovered/{ISO_timestamp}/
   * This method is non-fatal — if it fails, capture can still proceed.
   *
   * Called by PrintMonitor during job mismatch on startup, or when no
   * state file exists but orphaned frames are found.
   */
  rescueOrphanedFrames(): void {
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

  /**
   * Count how many captured frames currently exist in the temp directory.
   *
   * The count is computed by scanning the filesystem for `img_*.jpg` files
   * on every call — there is no in-memory counter. This ensures the value
   * is always accurate, even if frames were written before this process
   * started (e.g. after a resume from crash).
   *
   * @returns Number of `img_*.jpg` files present, or `0` if the directory
   *   does not exist or cannot be read.
   */
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
   *
   * @param jobId - PrusaLink job ID for the active print.
   * @param frameCount - Number of frames captured so far (used as the
   *   `startNumber` offset when resuming).
   * @param startedAt - ISO timestamp of when the overall capture session
   *   originally started (preserved across pauses).
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
   *
   * @returns The stored {@link CaptureState}, or `null` if absent or invalid.
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
   * Move all captured frames to a finished directory keyed by print ID.
   * Called after successful video assembly to keep the temp directory clean
   * while preserving frames for review or re-assembly.
   *
   * Frames are moved to: {tempDir}/finished/{printId}/
   *
   * @param printId - Identifier for the finished print (typically the
   *   PrusaLink job ID). Used as the subdirectory name.
   */
  archiveFrames(printId: string): void {
    try {
      const files = readdirSync(this.tempDir);
      const frames = files.filter(
        (f) => f.startsWith("img_") && f.endsWith(".jpg")
      );
      if (frames.length === 0) return;

      const archiveDir = join(this.tempDir, "finished", printId);
      mkdirSync(archiveDir, { recursive: true });

      for (const file of frames) {
        renameSync(join(this.tempDir, file), join(archiveDir, file));
      }
      console.log(`Archived ${frames.length} frames to: ${archiveDir}`);
    } catch (error) {
      console.error(`Failed to archive frames: ${(error as Error).message}`);
    }
  }
}

/**
 * Assemble all captured JPEG frames in the temp directory into a single
 * MP4 timelapse video, then generate a thumbnail image beside it.
 *
 * ## ffmpeg pipeline
 *
 * 1. **Frame input** — reads `img_%05d.jpg` from the temp directory using
 *    the configured output framerate (e.g. 30 fps).
 * 2. **Video encoding** — encodes with H.264 (`libx264`) and `yuv420p` pixel
 *    format for broad compatibility (QuickTime, browsers, media players).
 * 3. **Output** — writes a `.mp4` file to `outputPath`. The output directory
 *    is created if it does not already exist.
 * 4. **Thumbnail extraction** — after a successful encode, a second ffmpeg
 *    pass extracts the last frame of the video as a scaled JPEG thumbnail
 *    saved alongside the video at `{outputPath without .mp4}.thumb.jpg`.
 *    Thumbnail failure is non-fatal and only logs a warning.
 *
 * @param config - Timelapse configuration (temp directory, framerate, etc.).
 * @param outputPath - Absolute path where the MP4 file should be written.
 * @throws {TimelapseError} If no frames are found, the output directory
 *   cannot be created, or ffmpeg exits with a non-zero code.
 */
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

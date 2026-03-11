import { spawn } from "child_process";
import { resolve } from "path";
import { ApiError, PrusaLinkClient } from "../api/client";
import { assembleVideo, TimelapseCapture } from "../timelapse";
import { PrinterState } from "../types/api";
import { AppConfig } from "../types/config";

export class MonitorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MonitorError";
  }
}

export class PrintMonitor {
  private config: AppConfig;
  private apiClient: PrusaLinkClient;
  private timelapseCapture: TimelapseCapture;
  private currentPrintId: number | null = null;
  private isMonitoring = false;
  private monitoringInterval: NodeJS.Timeout | null = null;
  private lastPrinterState: PrinterState | null = null;
  private watchdogExpiry: number | null = null; // timestamp when watchdog expires
  private isHandlingCompletion = false;

  constructor(config: AppConfig) {
    this.config = config;
    this.apiClient = new PrusaLinkClient(config.prusaLink);
    this.timelapseCapture = new TimelapseCapture(config.timelapse);
  }

  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      throw new MonitorError("Monitoring already started");
    }

    console.log("Starting print monitoring...");
    this.isMonitoring = true;

    // Initial status check
    await this.checkStatus();

    // Start periodic monitoring
    this.monitoringInterval = setInterval(() => {
      this.checkStatus().catch((error) => {
        console.error(`Error during status check: ${error.message}`);
      });
    }, this.config.pollInterval * 1000);
  }

  async stopMonitoring(): Promise<void> {
    if (!this.isMonitoring) {
      return;
    }

    console.log("Stopping print monitoring...");
    this.isMonitoring = false;

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }

    // Stop any ongoing capture
    if (this.timelapseCapture.isCurrentlyCapturing()) {
      await this.stopTimelapseCapture();
    }
  }

  private async checkStatus(): Promise<void> {
    try {
      const status = await this.apiClient.getStatus();
      const currentState = status.printer.state;
      const currentJobId = status.job?.id || null;

      console.log(`Printer state: ${currentState}, Job ID: ${currentJobId}`);

      // Check for state transitions
      const previousState = this.lastPrinterState;

      // Print started
      if (
        previousState !== "PRINTING" &&
        currentState === "PRINTING" &&
        currentJobId !== null
      ) {
        await this.handlePrintStarted(currentJobId);
      }
      // Print finished/stopped - any transition from PRINTING to non-PRINTING
      else if (previousState === "PRINTING" && currentState !== "PRINTING") {
        await this.handlePrintFinished(currentJobId);
      }
      // If we're currently capturing and see PRINTING state, reset watchdog
      else if (
        this.timelapseCapture.isCurrentlyCapturing() &&
        currentState === "PRINTING"
      ) {
        this.resetWatchdog();
      }

      this.lastPrinterState = currentState;
      this.currentPrintId = currentJobId;

      // Check watchdog after processing status
      this.checkWatchdog();
    } catch (error) {
      if (error instanceof ApiError) {
        console.error(`API Error: ${error.message}`);
      } else {
        console.error(`Unexpected error: ${(error as Error).message}`);
      }
      // Continue monitoring despite errors

      // Still check watchdog even on API errors
      this.checkWatchdog();
    }
  }

  private async handlePrintStarted(jobId: number): Promise<void> {
    console.log(`Print started (Job ID: ${jobId})`);

    // Reject if already capturing (shouldn't happen, but safety check)
    if (this.timelapseCapture.isCurrentlyCapturing()) {
      console.warn(
        "Timelapse capture already in progress, rejecting new print"
      );
      return;
    }

    try {
      await this.timelapseCapture.startCapture();
      console.log("Timelapse capture started");

      // Start watchdog if enabled
      this.startWatchdog(jobId);
    } catch (error) {
      console.error(
        `Failed to start timelapse capture: ${(error as Error).message}`
      );
    }
  }

  private async handlePrintFinished(jobId: number | null): Promise<void> {
    if (this.isHandlingCompletion) {
      console.log("Print completion already in progress, skipping duplicate");
      return;
    }
    this.isHandlingCompletion = true;
    // Clear watchdog immediately so checkWatchdog doesn't re-fire during async work
    this.clearWatchdog();

    console.log(`Print finished (Job ID: ${jobId})`);

    try {
      if (!this.timelapseCapture.isCurrentlyCapturing()) {
        console.log("No active timelapse capture to stop");
        return;
      }

      // Stop capture
      await this.stopTimelapseCapture();

      // Assemble video
      const outputPath = this.generateOutputPath(jobId);
      await assembleVideo(this.config.timelapse, outputPath);

      // Send notification
      await this.sendNotification(outputPath);

      console.log(`Timelapse completed: ${outputPath}`);
    } catch (error) {
      console.error(
        `Error during timelapse completion: ${(error as Error).message}`
      );
    } finally {
      this.isHandlingCompletion = false;
    }
  }

  private async stopTimelapseCapture(): Promise<void> {
    try {
      await this.timelapseCapture.stopCapture();
      console.log("Timelapse capture stopped");
    } catch (error) {
      console.error(
        `Error stopping timelapse capture: ${(error as Error).message}`
      );
      throw error;
    }
  }

  private generateOutputPath(jobId: number | null): string {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, -5);
    const jobSuffix = jobId ? `_job${jobId}` : "";
    const filename = `timelapse_${timestamp}${jobSuffix}.mp4`;
    return resolve(this.config.timelapse.outputDirectory, filename);
  }

  private async sendNotification(outputPath: string): Promise<void> {
    try {
      // Execute the configured notification command
      const command = this.config.notification.command
        .replace("{outputPath}", outputPath)
        .replace("{outputDir}", this.config.timelapse.outputDirectory);

      console.log(`Executing notification command: ${command}`);

      await new Promise<void>((resolve, reject) => {
        const child = spawn(command, { shell: true, stdio: "inherit" });

        child.on("error", (error) => {
          reject(
            new MonitorError(`Notification command failed: ${error.message}`)
          );
        });

        child.on("exit", (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(
              new MonitorError(`Notification command exited with code ${code}`)
            );
          }
        });
      });

      console.log("Notification sent successfully");
    } catch (error) {
      console.error(`Failed to send notification: ${(error as Error).message}`);
      // Don't throw - notification failure shouldn't stop the process
    }
  }

  isCurrentlyMonitoring(): boolean {
    return this.isMonitoring;
  }

  getCurrentPrintId(): number | null {
    return this.currentPrintId;
  }

  isCapturing(): boolean {
    return this.timelapseCapture.isCurrentlyCapturing();
  }

  private startWatchdog(jobId: number): void {
    // Only start watchdog if enabled (> 0)
    if (this.config.watchdogTimeout <= 0) {
      return;
    }

    this.watchdogExpiry = Date.now() + this.config.watchdogTimeout * 1000;
    console.log(
      `Watchdog started: ${this.config.watchdogTimeout}s timeout for job ${jobId}`
    );
  }

  private resetWatchdog(): void {
    if (
      this.config.watchdogTimeout <= 0 ||
      !this.timelapseCapture.isCurrentlyCapturing()
    ) {
      return;
    }

    this.watchdogExpiry = Date.now() + this.config.watchdogTimeout * 1000;
    console.log(`Watchdog reset: ${this.config.watchdogTimeout}s remaining`);
  }

  private checkWatchdog(): void {
    if (
      this.config.watchdogTimeout <= 0 ||
      !this.timelapseCapture.isCurrentlyCapturing() ||
      this.watchdogExpiry === null
    ) {
      return;
    }

    const now = Date.now();
    if (now >= this.watchdogExpiry) {
      console.warn(
        `Watchdog triggered: No PRINTING state seen for ${this.config.watchdogTimeout}s`
      );
      console.warn("Forcing timelapse completion due to watchdog");

      // Use current print ID if available, otherwise null
      this.handlePrintFinished(this.currentPrintId).catch((error) => {
        console.error(
          `Error during watchdog-triggered completion: ${error.message}`
        );
      });
    }
  }

  private clearWatchdog(): void {
    this.watchdogExpiry = null;
    console.log("Watchdog cleared");
  }
}

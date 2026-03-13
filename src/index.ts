#!/usr/bin/env node

import { resolve } from "path";
import { ConfigError, loadConfig } from "./config";
import { MonitorError, PrintMonitor } from "./monitor";
import { createWebServer } from "./web/server";

// Parse command line arguments
function parseArgs(): { configPath: string } {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: prusa-timelapse <config-file>");
    console.error("Example: prusa-timelapse config.json");
    process.exit(1);
  }

  const configPath = resolve(args[0]);
  return { configPath };
}

// Main application
async function main(): Promise<void> {
  const { configPath } = parseArgs();

  console.log("Prusa Timelapse Service");
  console.log("======================");

  try {
    // Load configuration
    console.log(`Loading configuration from: ${configPath}`);
    const config = loadConfig(configPath);
    console.log("Configuration loaded successfully");

    // Create and start monitor
    const monitor = new PrintMonitor(config);

    // Handle graceful shutdown
    const shutdown = async (signal: string) => {
      console.log(`\nReceived ${signal}, shutting down gracefully...`);

      try {
        await monitor.stopMonitoring();
        console.log("Monitoring stopped successfully");
      } catch (error) {
        console.error(`Error during shutdown: ${(error as Error).message}`);
        process.exit(1);
      }

      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    // Start monitoring
    console.log("Starting monitoring service...");
    await monitor.startMonitoring();

    // Start web UI (disabled if webPort is 0)
    const webPort = config.webPort ?? 3000;
    if (webPort > 0) {
      createWebServer(config, webPort, monitor);
    }

    console.log("Service started successfully. Press Ctrl+C to stop.");
    console.log(`Polling interval: ${config.pollInterval} seconds`);
    console.log(
      `PrusaLink API: ${config.prusaLink.host}:${config.prusaLink.port}`
    );
    console.log(`RTSP URL: ${config.timelapse.rtspUrl}`);
    console.log(`Output directory: ${config.timelapse.outputDirectory}`);

    // Keep the process running
    setInterval(() => {
      // Periodic status check
      if (monitor.isCurrentlyMonitoring()) {
        const printId = monitor.getCurrentPrintId();
        const state = monitor.getMonitorState();
        console.log(
          `Status: ${state} | Print ID: ${printId || "None"}`
        );
      }
    }, 60000); // Log status every minute
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`Configuration error: ${error.message}`);
    } else if (error instanceof MonitorError) {
      console.error(`Monitor error: ${error.message}`);
    } else {
      console.error(`Unexpected error: ${(error as Error).message}`);
    }
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error(`Uncaught exception: ${error.message}`);
  console.error(error.stack);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the application
main().catch((error) => {
  console.error(`Failed to start application: ${error.message}`);
  process.exit(1);
});

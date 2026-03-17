import { createServer, IncomingMessage, ServerResponse } from "http";
import { join } from "path";
import { AppConfig } from "../types/config";
import { PrintMonitor } from "../monitor";
import {
  serveError,
  serveStatic,
  handleStatus,
  handleCameraSnapshot,
  handleStreamStart,
  handleStreamStop,
  handleHlsFile,
  handleVideoFile,
  handleVideoList,
  handleVideoThumbnail,
  handleRecoveredList,
  handleRecoveredThumbnail,
} from "./handlers";

// Vite builds the frontend to dist/web/frontend/ (sibling of this compiled file)
const FRONTEND_DIR = join(__dirname, "frontend");

export function createWebServer(config: AppConfig, port: number, monitor?: PrintMonitor): void {
  const server = createServer(
    (req: IncomingMessage, res: ServerResponse): void => {
      const method = req.method ?? "GET";
      const pathname = (req.url ?? "/").split("?")[0];

      // ---- Static frontend (Vite build output) ----
      if (pathname === "/" || pathname === "/index.html") {
        serveStatic(res, join(FRONTEND_DIR, "index.html"));
        return;
      }
      if (pathname.startsWith("/assets/")) {
        serveStatic(res, join(FRONTEND_DIR, pathname));
        return;
      }

      // ---- API routes (all under /api/) ----
      if (!pathname.startsWith("/api/")) {
        serveError(res, 404, "Not found");
        return;
      }

      if (method === "GET") {
        if (pathname === "/api/status") {
          const getState = monitor ? () => monitor.getMonitorState() : undefined;
          handleStatus(res, config, getState).catch(() =>
            serveError(res, 500, "Internal error")
          );
        } else if (pathname === "/api/camera.jpg") {
          handleCameraSnapshot(res, config).catch(() =>
            serveError(res, 500, "Internal error")
          );
        } else if (pathname.startsWith("/api/camera/hls/")) {
          handleHlsFile(res, pathname.slice("/api/camera/hls/".length));
        } else if (pathname === "/api/videos") {
          handleVideoList(res, config);
        } else if (
          pathname.startsWith("/api/videos/") &&
          !pathname.endsWith("/thumb.jpg")
        ) {
          const name = decodeURIComponent(pathname.slice("/api/videos/".length));
          handleVideoFile(req, res, config, name);
        } else if (
          pathname.startsWith("/api/videos/") &&
          pathname.endsWith("/thumb.jpg")
        ) {
          const name = decodeURIComponent(
            pathname.slice("/api/videos/".length, -"/thumb.jpg".length)
          );
          handleVideoThumbnail(res, config, name).catch(() =>
            serveError(res, 500, "Internal error")
          );
        } else if (pathname === "/api/recovered") {
          handleRecoveredList(res, config);
        } else if (
          pathname.startsWith("/api/recovered/") &&
          pathname.endsWith("/thumb.jpg")
        ) {
          const name = decodeURIComponent(
            pathname.slice("/api/recovered/".length, -"/thumb.jpg".length)
          );
          handleRecoveredThumbnail(res, config, name);
        } else {
          serveError(res, 404, "Not found");
        }
        return;
      }

      if (method === "POST") {
        if (pathname === "/api/camera/stream/start") {
          handleStreamStart(res, config).catch(() =>
            serveError(res, 500, "Internal error")
          );
        } else if (pathname === "/api/camera/stream/stop") {
          handleStreamStop(res, config);
        } else {
          serveError(res, 404, "Not found");
        }
        return;
      }

      serveError(res, 405, "Method not allowed");
    }
  );

  server.on("error", (err) => {
    console.error(`Web server error: ${err.message}`);
  });

  server.listen(port, () => {
    console.log(`Web UI: http://localhost:${port}`);
  });
}

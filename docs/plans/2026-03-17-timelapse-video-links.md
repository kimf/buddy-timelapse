# Timelapse Video Links Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make timelapse cards in the frontend open and play the video in a new browser tab using the browser's native player.

**Architecture:** Add a `GET /api/videos/:name` route that streams the `.mp4` file with HTTP range request support (enabling seeking). Wrap the frontend video cards in `<a target="_blank">` links pointing to that route.

**Tech Stack:** Node.js `http` + `fs.createReadStream`, TypeScript, Vite (frontend build)

---

### Task 1: Add `handleVideoFile` to `handlers.ts`

**Files:**
- Modify: `src/web/handlers.ts`

No test framework exists in this project — verify with `curl` commands after each step.

**Step 1: Add the handler function**

Open `src/web/handlers.ts` and add this function after `handleVideoThumbnail` (around line 247):

```typescript
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
  const rangeHeader = (req as IncomingMessage & { headers: Record<string, string | undefined> }).headers["range"];

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : size - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Cache-Control": "no-store",
    });
    createReadStream(videoPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Length": size,
      "Cache-Control": "no-store",
    });
    createReadStream(videoPath).pipe(res);
  }
}
```

You also need to add `createReadStream` and `IncomingMessage` to the imports at the top of the file. `IncomingMessage` is already imported from `"http"` — add `createReadStream` to the `"fs"` import:

```typescript
// Change:
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
// To:
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "fs";
```

And add `IncomingMessage` to the `"http"` import:

```typescript
// Change:
import { ServerResponse } from "http";
// To:
import { IncomingMessage, ServerResponse } from "http";
```

**Step 2: Build to check for TypeScript errors**

```bash
npm run build:server
```

Expected: exits 0, no errors.

**Step 3: Commit**

```bash
git add src/web/handlers.ts
git commit -m "feat: add handleVideoFile with range request support"
```

---

### Task 2: Wire the route in `server.ts`

**Files:**
- Modify: `src/web/server.ts`

**Step 1: Import `handleVideoFile`**

In `src/web/server.ts`, add `handleVideoFile` to the import from `"./handlers"`:

```typescript
// Change:
import {
  serveError,
  serveStatic,
  handleStatus,
  handleCameraSnapshot,
  handleStreamStart,
  handleStreamStop,
  handleHlsFile,
  handleVideoList,
  handleVideoThumbnail,
  handleRecoveredList,
  handleRecoveredThumbnail,
} from "./handlers";
// To:
import {
  serveError,
  serveStatic,
  handleStatus,
  handleCameraSnapshot,
  handleStreamStart,
  handleStreamStop,
  handleHlsFile,
  handleVideoList,
  handleVideoFile,
  handleVideoThumbnail,
  handleRecoveredList,
  handleRecoveredThumbnail,
} from "./handlers";
```

**Step 2: Add the route**

In the GET handler block, add a new route **before** the existing `/thumb.jpg` route. The order matters — the thumb route must stay below so its more-specific pattern takes priority:

```typescript
// Add this block BEFORE the existing thumb.jpg block:
} else if (
  pathname.startsWith("/api/videos/") &&
  !pathname.endsWith("/thumb.jpg")
) {
  const name = decodeURIComponent(pathname.slice("/api/videos/".length));
  handleVideoFile(req, res, config, name);
```

The full GET block will look like this after the change (showing the relevant section):

```typescript
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
```

Note: `handleVideoFile` needs access to `req` — the route handler callback already receives it as the first argument. Confirm the existing `createServer` callback signature is `(req: IncomingMessage, res: ServerResponse)` — it is (line 24 of `server.ts`).

**Step 3: Build to check for TypeScript errors**

```bash
npm run build:server
```

Expected: exits 0, no errors.

**Step 4: Manual smoke test**

Start the server and verify the endpoint with curl (replace `your-video.mp4` with an actual file from your output directory):

```bash
# Full file response
curl -I http://localhost:<port>/api/videos/your-video.mp4
# Expected headers include:
# HTTP/1.1 200 OK
# Content-Type: video/mp4
# Accept-Ranges: bytes

# Range request (first 1MB)
curl -I -H "Range: bytes=0-1048575" http://localhost:<port>/api/videos/your-video.mp4
# Expected headers include:
# HTTP/1.1 206 Partial Content
# Content-Range: bytes 0-1048575/<total>
```

**Step 5: Commit**

```bash
git add src/web/server.ts
git commit -m "feat: add GET /api/videos/:name route for video streaming"
```

---

### Task 3: Make video cards clickable in the frontend

**Files:**
- Modify: `src/web/frontend/videos.ts`

**Step 1: Update `fetchVideos` to wrap cards in links**

In `src/web/frontend/videos.ts`, find the loop inside `fetchVideos` (around line 72) and replace it:

```typescript
// Change:
    grid.innerHTML = "";
    for (const item of videos) {
      const thumb = `/api/videos/${encodeURIComponent(item.name)}/thumb.jpg`;
      const label = item.name.replace(/\.mp4$/i, "");
      const meta = `${fmtDate(item.mtime)} · ${fmtSize(item.size)}`;
      grid.appendChild(buildCard(thumb, label, meta));
    }
// To:
    grid.innerHTML = "";
    for (const item of videos) {
      const thumb = `/api/videos/${encodeURIComponent(item.name)}/thumb.jpg`;
      const label = item.name.replace(/\.mp4$/i, "");
      const meta = `${fmtDate(item.mtime)} · ${fmtSize(item.size)}`;
      const card = buildCard(thumb, label, meta);
      const link = document.createElement("a");
      link.href = `/api/videos/${encodeURIComponent(item.name)}`;
      link.target = "_blank";
      link.rel = "noopener";
      link.appendChild(card);
      grid.appendChild(link);
    }
```

**Step 2: Build the full project**

```bash
npm run build
```

Expected: exits 0, no errors.

**Step 3: Manual smoke test**

Open the web UI in a browser. The timelapse cards should now be visually clickable (cursor changes to pointer on hover). Click one — it should open the video in a new tab and be playable/seekable.

**Step 4: Commit**

```bash
git add src/web/frontend/videos.ts
git commit -m "feat: make timelapse cards link to video for in-browser playback"
```

# Design: Timelapse Video Links

**Date:** 2026-03-17

## Goal

Make timelapse cards in the frontend clickable so the video opens and plays directly in a new browser tab using the browser's native video player.

## Backend

### New route

`GET /api/videos/:name` — serves the raw `.mp4` file with HTTP range request support.

### Handler behaviour

1. Resolve and validate the file path (same `basename` safety check as the thumbnail handler).
2. Stat the file for `Content-Length`.
3. If a `Range` header is present, parse byte range, open a read stream for that slice, respond `206 Partial Content` with `Content-Range` and `Accept-Ranges: bytes`.
4. If no `Range` header, respond `200` streaming the full file with `Accept-Ranges: bytes`.
5. `Content-Type: video/mp4`.

Range support is required so the browser's native player can seek/scrub without downloading the whole file first.

### Files changed

- `src/web/handlers.ts` — add `handleVideoFile` function
- `src/web/server.ts` — add route match for `GET /api/videos/:name` (before the existing `/thumb.jpg` route)

## Frontend

### Card link wrapping

In `src/web/frontend/videos.ts`, update `buildCard` calls for video items to wrap the returned element in:

```html
<a href="/api/videos/{encodedName}" target="_blank" rel="noopener">
```

Only the completed video cards are linked. Recovered frame cards are unchanged.

## Non-goals

- No modal/overlay player
- No download button
- No changes to recovered cards

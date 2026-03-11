import { initCamera } from "./camera";
import { initStatus } from "./status";
import { initVideos } from "./videos";

document.addEventListener("DOMContentLoaded", () => {
  initCamera();
  initStatus();
  initVideos();
});

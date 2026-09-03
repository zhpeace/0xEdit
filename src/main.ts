import { App } from "./app";

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("dark");
  const app = new App();
  app.init();
  window.__app = app;
});

declare global {
  interface Window {
    __app: App;
  }
}
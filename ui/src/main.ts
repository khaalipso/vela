import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import { app } from "./lib/app.svelte";
import { createBackend, pinnedSpace } from "./lib/backend";

// A window opened with W carries `#space-<id>` and shows only that space.
void app.init(createBackend(), pinnedSpace(window.location.hash));

export default mount(App, { target: document.getElementById("root")! });

import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./app.css";
import { mount } from "svelte";
import App from "./App.svelte";
import LooseFile from "./components/LooseFile.svelte";
import { app } from "./lib/app.svelte";
import { createBackend, pinnedSpace } from "./lib/backend";

// A window opened with W carries `#space-<id>` and shows only that space.
// A window opened for one loose file carries `#file=<path>` and shows only that file.
const loose = /^#file=(.+)$/.exec(window.location.hash);
if (!loose) void app.init(createBackend(), pinnedSpace(window.location.hash));

const target = document.getElementById("root")!;
export default loose ? mount(LooseFile, { target, props: { path: decodeURIComponent(loose[1]) } }) : mount(App, { target });

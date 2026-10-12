/** @lifespan PRODUCTION — SPA entry; mounts <Gate/> (configurator → console). */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Gate } from "./Gate.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><Gate /></StrictMode>);

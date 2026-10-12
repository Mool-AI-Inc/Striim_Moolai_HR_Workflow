/** @lifespan PRODUCTION — one-time gate: show the connect-your-stack configurator, then mount the console.
 *  App (and its polling effects) mounts only after Launch, so nothing runs behind the configurator. */
import { useState } from "react";
import { Configurator } from "./Configurator.js";
import { App } from "./App.js";

export function Gate() {
  const [launched, setLaunched] = useState(false);
  return launched ? <App /> : <Configurator onLaunch={() => setLaunched(true)} />;
}

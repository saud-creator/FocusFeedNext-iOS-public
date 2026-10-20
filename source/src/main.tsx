import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

const root=createRoot(document.getElementById("root")!);
if(__FFN_UI_TEST__) {
  void import('../tools/ios-ui-tests/FixtureApp').then(async ({testApplication})=>root.render(await testApplication(<App/>)));
} else root.render(<StrictMode><App /></StrictMode>);

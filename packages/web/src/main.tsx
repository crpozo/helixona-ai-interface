import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { brand } from "./brand";

// El título es fijo: nunca contiene datos de la conversación.
document.title = brand.productName;

if (import.meta.env.MODE === "demo") {
  const { installMockApi } = await import("./demo/mockApi");
  installMockApi();
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

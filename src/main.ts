import "./style.css";
import { setupPanels } from "./ui/panels.ts";
import { setupProviderSelect } from "./ui/provider-select.ts";
import { setupWarm } from "./ui/warm.ts";

setupWarm(document);
setupPanels(document, setupProviderSelect(document));

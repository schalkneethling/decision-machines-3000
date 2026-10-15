import "./style.css";
import { setupPanels } from "./ui/panels.ts";
import { setupProviderSelect } from "./ui/provider-select.ts";
import { setupWarm } from "./ui/warm.ts";

const selection = setupProviderSelect(document);
const warm = setupWarm(document, selection);
setupPanels(document, selection, { onAnswered: warm.noteAnswered });

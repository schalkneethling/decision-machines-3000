import "./style.css";
import { setupRequestForm } from "./ui/request-form.ts";
import { setupProviderSelect } from "./ui/provider-select.ts";
import { setupWarm } from "./ui/warm.ts";

const selection = setupProviderSelect(document);
const warm = setupWarm(document, selection);
setupRequestForm(document, selection, { onAnswered: warm.noteAnswered });

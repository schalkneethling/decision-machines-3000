// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createConfirmDialog } from "./confirm-dialog.ts";

function dialog(): HTMLDialogElement {
  const found = document.querySelector<HTMLDialogElement>("dialog");
  if (found === null) throw new Error("No dialog.");
  return found;
}

function title(): string | null {
  return dialog().querySelector(".confirm-title")?.textContent ?? null;
}

function press(value: "cancel" | "confirm"): void {
  dialog().querySelector<HTMLButtonElement>(`button[value="${value}"]`)?.click();
}

/** Lets the queued question that follows an answer open. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = `
    <dialog>
      <form method="dialog">
        <h2 class="confirm-title"></h2>
        <p class="confirm-message"></p>
        <button type="submit" value="cancel">Keep</button>
        <button type="submit" value="confirm">Load</button>
      </form>
    </dialog>`;
});

describe("createConfirmDialog (issue #58)", () => {
  it("asks a second question only once the first is answered, and answers each on its own", async () => {
    const confirm = createConfirmDialog(dialog());
    const first = confirm({ title: "First?", message: "It costs one thing." });
    const second = confirm({ title: "Second?", message: "It costs another." });
    await flush();
    expect(title()).toBe("First?");

    press("confirm");
    expect(await first).toBe(true);
    await flush();
    expect(dialog().open).toBe(true);
    expect(title()).toBe("Second?");

    press("cancel");
    expect(await second).toBe(false);
    expect(dialog().open).toBe(false);
  });
});

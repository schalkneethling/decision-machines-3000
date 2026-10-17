import { required } from "./dom.ts";

/** What a confirmation asks: the question as its heading, and a sentence on what agreeing costs. */
export type Confirmation = { title: string; message: string };

/** Asks `confirmation` and resolves true only when the person presses the confirming button. */
export type Confirm = (confirmation: Confirmation) => Promise<boolean>;

/** The `returnValue` the confirming button's `value` gives the dialog when its `method="dialog"` form submits. */
const CONFIRMED = "confirm";

/**
 * Asks through `dialog`, the page's modal `<dialog>` whose form uses
 * `method="dialog"`. `showModal()` makes the rest of the page inert until the
 * person answers. Escape fires `cancel` and closes the dialog without touching
 * `returnValue`, which is reset before each question, so it counts as "no", as
 * does the cancel button. Only the button whose value is `confirm` says yes.
 * The page has one dialog for every panel, so questions take turns: one asked
 * while another is open waits until that one is answered, rather than
 * overwriting its text and sharing its answer.
 */
export function createConfirmDialog(dialog: HTMLDialogElement): Confirm {
  const title = required(dialog, ".confirm-title", HTMLElement);
  const message = required(dialog, ".confirm-message", HTMLElement);
  let turn: Promise<unknown> = Promise.resolve();

  const ask = ({ title: question, message: cost }: Confirmation): Promise<boolean> =>
    new Promise((resolve) => {
      title.textContent = question;
      message.textContent = cost;
      dialog.returnValue = "";
      dialog.addEventListener("close", () => resolve(dialog.returnValue === CONFIRMED), {
        once: true,
      });
      dialog.showModal();
    });

  return (confirmation) => {
    const answer = turn.then(() => ask(confirmation));
    turn = answer;
    return answer;
  };
}

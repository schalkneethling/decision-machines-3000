/** The element `selector` finds under `root`, or an error naming the missing markup. */
export function required<T extends Element>(
  root: ParentNode,
  selector: string,
  type: abstract new () => T,
): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) {
    throw new Error(`DecisionMachines3000 markup is missing ${selector}.`);
  }
  return element;
}

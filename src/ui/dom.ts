type ElementOptions = {
  className?: string;
  text?: string;
  attributes?: Record<string, string>;
};

/** Builds an element with optional class, text, attributes, and children. */
export function create<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  { className, text, attributes = {} }: ElementOptions = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.append(...children);
  return element;
}

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

/** Appends text, turning `backticked` spans into `<code>` elements. */
export function appendWithInlineCode(parent: HTMLElement, text: string): void {
  text.split(/`([^`]+)`/).forEach((part, index) => {
    if (part === "") {
      return;
    }
    parent.append(index % 2 === 1 ? create("code", { text: part }) : part);
  });
}

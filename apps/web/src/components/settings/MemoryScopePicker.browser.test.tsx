import { expect, it, vi } from "vite-plus/test";
import { act, render, stubGlobal } from "../../../test/render";
import { MemoryScopePicker } from "./MemoryScopePicker";
// Layout is stubbed so the virtualized list measures stable sizes in a headless browser.
function stubLayout() {
  const stack = new DisposableStack();
  stack.use(
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      return new DOMRect(0, 0, 320, this.dataset.slot === "combobox-item" ? 32 : 224);
    }),
  );
  stack.use(vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(224));
  stack.use(vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320));
  // LegendList measures layout sizes so popup transforms do not distort row heights.
  stack.use(
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.dataset.slot === "combobox-item" ? 32 : 224;
    }),
  );
  stack.use(vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(320));
  stack.use(vi.spyOn(HTMLElement.prototype, "scrollTo").mockImplementation(() => {}));
  return stack;
}
it.each([200, 2000])(
  "virtualizes %i records and searches/selects the final destination",
  async (count) => {
    using _layout = stubLayout();
    using _observer = stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const select = vi.fn();
    await using screen = await render(
      <MemoryScopePicker
        items={Array.from({ length: count }, (_, i) => ({
          id: `record-${i}`,
          title: `Destination ${i}`,
        }))}
        value={null}
        onChange={select}
        label="Memory thread"
        disabled={false}
      />,
      // The picker has no router dependency.
      { router: false },
    );
    await act(async () => screen.container.querySelector<HTMLButtonElement>("button")!.click());
    const rows = () => document.querySelectorAll('[data-slot="combobox-item"]');
    expect(rows().length).toBeGreaterThan(0);
    expect(rows().length).toBeLessThan(40);
    const input = document.querySelector<HTMLInputElement>(
      'input[aria-label="Search memory thread"]',
    )!;
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        `Destination ${count - 1}`,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(rows().length).toBeLessThan(40);
    const last = [...rows()].find(
      (row) => row.textContent === `Destination ${count - 1}`,
    ) as HTMLElement;
    expect(last).toBeDefined();
    await act(async () => last.click());
    expect(select).toHaveBeenLastCalledWith(`record-${count - 1}`);
  },
);

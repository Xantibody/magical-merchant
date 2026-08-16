const cache = new Map();
function load(name) {
  if (!cache.has(name)) {
    cache.set(
      name,
      fetch(`assets/regular/${name}.svg`).then((r) => r.text()),
    );
  }
  return cache.get(name);
}
customElements.define(
  "mm-icon",
  class extends HTMLElement {
    static observedAttributes = ["name", "size"];
    connectedCallback() {
      this.render();
    }
    attributeChangedCallback() {
      this.render();
    }
    async render() {
      const name = this.getAttribute("name");
      if (!name) return;
      const size = this.getAttribute("size") || "24";
      const svg = await load(name);
      if (this.getAttribute("name") !== name) return;
      this.style.display = "inline-flex";
      this.style.lineHeight = "0";
      this.innerHTML = svg;
      const el = this.querySelector("svg");
      if (el) {
        el.setAttribute("width", size + "px");
        el.setAttribute("height", size + "px");
        el.setAttribute("fill", "currentColor");
      }
    }
  },
);

/* A PAGE WITHOUT A BROWSER, just enough of one for the library to be mounted
   and pressed: elements, attributes, events, a few selectors. No layout: what
   takes room is checked against the style sheet by the tests themselves. */

class FakeNode {
    constructor() { this.childNodes = []; this.parentNode = null; this.listeners = new Map(); }
    get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
    set textContent(text) { this.replaceChildren(...(String(text) === '' ? [] : [String(text)])); }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    dispatchEvent(event) {
        event.target ??= this;
        for (let at = this; at; at = at.parentNode ?? (at === globalThis.document?.body ? globalThis.document : null)) {
            for (const fn of [...(at.listeners.get(event.type) ?? [])]) fn.call(at, event);
            if (event.bubbles === false || event.stopped) break;
        }
        return !event.defaultPrevented;
    }
    contains(other) { for (let at = other; at; at = at.parentNode) if (at === this) return true; return false; }
    append(...nodes) {
        for (const n of nodes) {
            const node = typeof n === 'string' ? new FakeText(n) : n;
            node.parentNode?.removeChild(node);
            node.parentNode = this; this.childNodes.push(node);
        }
    }
    removeChild(node) { this.childNodes = this.childNodes.filter((n) => n !== node); node.parentNode = null; lose(node); }
    replaceWith(...nodes) { const parent = this.parentNode; if (!parent) return; const at = parent.childNodes.indexOf(this); const made = nodes.map((n) => (typeof n === 'string' ? new FakeText(n) : n)); for (const n of made) { n.parentNode?.removeChild(n); n.parentNode = parent; } parent.childNodes.splice(at, 1, ...made); this.parentNode = null; }
    replaceChildren(...nodes) { for (const n of this.childNodes) { n.parentNode = null; lose(n); } this.childNodes = []; this.append(...nodes); }
}
/* As in a browser: a node taken out of the page takes the focus with it, even when it is put back at once. */
function lose(node) { const d = globalThis.document; if (d?.activeElement && d.activeElement !== d.body && node.contains?.(d.activeElement)) d.activeElement = d.body; }
class FakeText extends FakeNode {
    constructor(text) { super(); this.data = text; this.nodeType = 3; }
    get textContent() { return this.data; }
    set textContent(text) { this.data = String(text); }
}
const SIMPLE = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:="?[^\]"]*"?)?\])*)$/i;
function matches(element, selector) {
    return selector.split(',').map((s) => s.trim()).some((one) => {
        const m = SIMPLE.exec(one);
        if (!m) throw new Error(`the fake page does not know the selector ${one}`);
        if (m[1] && element.tagName !== m[1].toUpperCase()) return false;
        for (const c of m[2].split('.').filter(Boolean)) if (!element.classList.contains(c)) return false;
        for (const [, name, value] of m[3].matchAll(/\[([\w-]+)(?:="?([^\]"]*)"?)?\]/g)) {
            if (!element.hasAttribute(name)) return false;
            if (value !== undefined && element.getAttribute(name) !== value) return false;
        }
        return true;
    });
}
class FakeElement extends FakeNode {
    constructor(tag) {
        super();
        this.nodeType = 1;
        this.tagName = tag.toUpperCase(); this.attributes = new Map(); this.style = {}; this.hidden = false; this.disabled = false;
        this.value = ''; this.scrollTop = 0; this.scrollHeight = 0; this.clientWidth = 0; this.clientHeight = 0; this.title = ''; this.placeholder = '';
        const element = this;
        this.dataset = new Proxy({}, {
            get: (_, key) => element.getAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
            set: (_, key, value) => { element.setAttribute(`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value)); return true; },
            deleteProperty: (_, key) => { element.removeAttribute(`data-${String(key)}`); return true; },
            has: (_, key) => element.hasAttribute(`data-${String(key)}`),
        });
        this.classList = {
            add: (...names) => { const set = new Set(element.className.split(/\s+/).filter(Boolean)); for (const n of names) set.add(n); element.className = [...set].join(' '); },
            remove: (...names) => { element.className = element.className.split(/\s+/).filter((c) => c && !names.includes(c)).join(' '); },
            contains: (name) => element.className.split(/\s+/).includes(name),
        };
    }
    get className() { return this.getAttribute('class') ?? ''; }
    set className(value) { this.setAttribute('class', value); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    hasAttribute(name) { return name === 'hidden' ? this.hidden : this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    get children() { return this.childNodes.filter((n) => n instanceof FakeElement); }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let at = this; at instanceof FakeElement; at = at.parentNode) if (at.matches(selector)) return at; return null; }
    querySelectorAll(selector) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(selector)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; }
    getAttributeNames() { return [...this.attributes.keys()]; }
    scrollIntoView() {}
    setSelectionRange() {}
    focus() { globalThis.document.activeElement = this; }
    blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = globalThis.document.body; }
    click() {
        if (this.disabled) return;
        const event = fakeEvent('click');
        this.dispatchEvent(event);
        if (!event.defaultPrevented && this.tagName === 'BUTTON' && this.type === 'submit') this.closest('form')?.requestSubmit();
    }
    requestSubmit() { this.dispatchEvent(fakeEvent('submit')); }
}
export const fakeEvent = (type, more = {}) => ({ type, bubbles: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...more });

/* Installs the page on globalThis; returns a function that takes it away. */
export function fakePage() {
    const names = ['document', 'Node', 'Element', 'requestAnimationFrame', 'getSelection'];
    const before = Object.fromEntries(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
    const document = new FakeNode();
    document.hidden = false;
    document.createElement = (tag) => new FakeElement(tag);
    document.createElementNS = (ns, tag) => new FakeElement(tag);
    document.body = new FakeElement('body');
    document.activeElement = document.body;
    Object.assign(globalThis, { document, Node: FakeNode, Element: FakeElement, requestAnimationFrame: (fn) => setTimeout(fn, 0), getSelection: () => '' });
    return () => { for (const n of names) { if (before[n]) Object.defineProperty(globalThis, n, before[n]); else delete globalThis[n]; } };
}

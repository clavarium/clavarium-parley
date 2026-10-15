/* THE EXCHANGE, SHOWN. One file, no framework, for any page.
 *
 *   import { mount } from './parley-ui.js';
 *   mount(element, { load, send, words, open, terminal, remind, view, onView });
 *
 *   load()                 resolves with what parley-host.mjs read() gives
 *   send(text, answers)    the person wrote; `answers` is the id of the
 *                          question a choice answers
 *   words                  the words of the screen: texts(lang, own) of
 *                          parley-host.mjs, or any object with those keys
 *   open(file)             optional: opens a file the agent showed (`file`
 *                          is { path, open }: `open` is the application's
 *                          own reference, null when it cannot be opened)
 *   terminal()             optional: shows the agent's terminal
 *   remind()               optional: tells the agent again that a message waits
 *   view                   'simple' or 'detailed'; onView(view) when changed
 *
 * TWO VIEWS OF ONE EXCHANGE. Simple: the messages, the choices to answer
 * with, the files. Detailed: the same, with where the agent says it is, the
 * steps it said, every file it showed, and a way to its terminal.
 *
 * EVERYTHING AN AGENT WROTE, AND EVERY WORD OF THE DICTIONARY, IS PUT ON THE
 * PAGE AS TEXT, never as markup: the first is chosen by a program, the
 * second by whoever wrote the dictionary.
 */
export const VIEWS = Object.freeze(['simple', 'detailed']);
/* The words this screen uses: a dictionary needs these keys. */
export const KEYS = Object.freeze(['send', 'placeholder', 'empty', 'view', 'simple', 'detailed', 'working', 'waiting', 'done', 'no-status', 'asks', 'open', 'outside',
    'not-read', 'read', 'remind', 'reminded', 'steps', 'no-steps', 'files', 'no-files', 'terminal', 'not-sent']);

const fill = (word, values = {}) => String(word ?? '').replace(/\{([a-z]+)\}/g, (all, key) => (Object.hasOwn(values, key) ? String(values[key]) : all));
const said = (words, key, values) => fill(typeof words?.[key] === 'string' ? words[key] : key, values);
const when = (at) => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

/* WHAT IS SHOWN, as plain data: the page is built from this and from nothing
   else, so it can be checked without a page. */
export function view(data, { words = {}, view: as = 'simple' } = {}) {
    const detailed = as === 'detailed';
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const answered = new Set(messages.map((m) => m.answers).filter(Boolean));
    const status = data?.status ?? null;
    const state = (s) => said(words, ['working', 'waiting', 'done'].includes(s) ? s : 'working');
    /* The last of the person's messages the agent has not read yet: the one that says so. */
    const lastUnseen = [...messages].reverse().find((m) => m.from === 'person' && m.seen === false)?.id;
    return {
        view: detailed ? 'detailed' : 'simple',
        /* Simple says only what asks for the person: that it waits. */
        status: detailed
            ? { state: status?.state ?? 'none', text: status ? `${state(status.state)}${status.note ? ` - ${status.note}` : ''}` : said(words, 'no-status'), at: status ? when(status.at) : '' }
            : status?.state === 'waiting' ? { state: 'waiting', text: `${state('waiting')}${status.note ? ` - ${status.note}` : ''}`, at: '' } : null,
        empty: messages.length === 0 ? said(words, 'empty') : null,
        items: messages.map((m) => {
            const show = m.kind === 'show';
            const open = m.kind === 'ask' && !answered.has(m.id);
            return {
                id: String(m.id ?? ''), from: m.from === 'person' ? 'person' : 'agent', kind: String(m.kind ?? 'say'),
                text: show ? String(m.text || String(m.path ?? '').split('/').pop()) : String(m.text ?? ''),
                at: detailed ? when(m.at) : '',
                label: open ? said(words, 'asks') : '',
                file: show ? { path: String(m.path ?? ''), open: typeof m.open === 'string' ? m.open : null } : null,
                outside: show && typeof m.open !== 'string' ? said(words, 'outside', { path: String(m.path ?? '') }) : '',
                choices: open ? (m.choices ?? []).map(String) : [],
                open,
                mark: m.from === 'person' && m.id === lastUnseen ? said(words, 'not-read') : '',
            };
        }),
        unread: Number(data?.unread) || 0,
        steps: detailed ? (Array.isArray(data?.steps) ? data.steps : []).slice().reverse().map((s) => ({ state: s.state, text: `${state(s.state)}${s.note ? ` - ${s.note}` : ''}`, at: when(s.at) })) : [],
        files: detailed ? (Array.isArray(data?.files) ? data.files : []).slice().reverse().map((f) => ({ path: String(f.path ?? ''), name: String(f.path ?? '').split('/').pop(), note: String(f.note ?? ''), open: typeof f.open === 'string' ? f.open : null, at: when(f.at) })) : [],
    };
}

const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const button = (text, className, act) => { const b = el('button', className, text); b.type = 'button'; b.addEventListener('click', act); return b; };

export function mount(root, { load, send, words = {}, open, terminal, remind, view: first = 'simple', onView, every = 3000 } = {}) {
    let as = VIEWS.includes(first) ? first : 'simple';
    root.classList.add('parley');
    const top = el('div', 'parley-top');
    const status = el('p', 'parley-status'); status.setAttribute('role', 'status');
    const switcher = el('div', 'parley-views'); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', said(words, 'view'));
    const choose = (v) => { if (v === as) return; as = v; root.dataset.view = as; shown = ''; try { onView?.(as); } catch { /* the page's business */ } void refresh(); };
    const toggles = VIEWS.map((v) => { const b = button(said(words, v), '', () => choose(v)); b.dataset.view = v; return b; });
    switcher.append(...toggles);
    top.append(status, switcher);
    const main = el('div', 'parley-main');
    const thread = el('div', 'parley-thread'); thread.setAttribute('aria-live', 'polite');
    const aside = el('aside', 'parley-aside');
    main.append(thread, aside);
    const form = el('form', 'parley-form'); form.autocomplete = 'off';
    const box = el('textarea', 'parley-box'); box.rows = 2; box.maxLength = 4000; box.placeholder = said(words, 'placeholder'); box.setAttribute('aria-label', said(words, 'placeholder'));
    const go = el('button', 'parley-send', said(words, 'send')); go.type = 'submit';
    const problem = el('p', 'parley-problem'); problem.hidden = true; problem.setAttribute('role', 'alert');
    form.append(box, go);
    root.replaceChildren(top, main, form, problem);
    root.dataset.view = as;
    let shown = '';
    let count = 0;
    const say = async (text, answers) => {
        problem.hidden = true;
        try { await send(text, answers); await refresh(); } catch (error) { problem.textContent = said(words, 'not-sent', { error: String(error?.message ?? error) }); problem.hidden = false; }
    };
    const fileButton = (file) => {
        if (file.open === null || !open) return null;
        const b = button(said(words, 'open'), 'parley-open', () => open(file)); return b;
    };
    function paint(data) {
        const v = view(data, { words, view: as });
        const mark = JSON.stringify(v);
        if (mark === shown) return;
        shown = mark;
        for (const b of toggles) b.setAttribute('aria-pressed', String(b.dataset.view === v.view));
        status.hidden = !v.status;
        if (v.status) { status.dataset.state = v.status.state; status.textContent = v.status.at ? `${v.status.text} (${v.status.at})` : v.status.text; }
        /* The newest is shown: at the first paint, when something new came, and when the reader was at the bottom already. */
        const atBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40 || v.items.length > count;
        count = v.items.length;
        thread.replaceChildren(...v.items.map((item) => {
            const bubble = el('div', 'parley-said'); bubble.dataset.from = item.from; bubble.dataset.kind = item.kind; if (item.open) bubble.dataset.open = 'true';
            if (item.label) bubble.append(el('p', 'parley-label', item.label));
            bubble.append(el('p', 'parley-text', item.text));
            if (item.file) {
                const row = el('div', 'parley-file');
                row.append(el('span', 'parley-path', item.file.path));
                const b = fileButton(item.file); if (b) row.append(b);
                bubble.append(row);
                if (item.outside) bubble.append(el('p', 'parley-outside', item.outside));
            }
            if (item.choices.length > 0) {
                const row = el('div', 'parley-choices');
                for (const choice of item.choices) row.append(button(choice, '', () => { for (const x of row.children) x.disabled = true; void say(choice, item.id); }));
                bubble.append(row);
            }
            if (item.at || item.mark) {
                const foot = el('p', 'parley-foot', [item.at, item.mark].filter(Boolean).join(' - '));
                if (item.mark && remind && v.view === 'detailed') {
                    foot.append(' ', button(said(words, 'remind'), 'parley-remind', async (event) => { event.target.disabled = true; try { await remind(); event.target.textContent = said(words, 'reminded'); } catch { event.target.disabled = false; } }));
                }
                bubble.append(foot);
            }
            return bubble;
        }));
        if (v.empty) thread.append(el('p', 'parley-empty', v.empty));
        aside.hidden = v.view !== 'detailed';
        if (v.view === 'detailed') {
            const steps = el('section', 'parley-steps');
            steps.append(el('h3', '', said(words, 'steps')));
            if (v.steps.length === 0) steps.append(el('p', 'parley-empty', said(words, 'no-steps')));
            else { const list = el('ol'); for (const s of v.steps) { const li = el('li', '', s.text); li.dataset.state = s.state; if (s.at) li.append(' ', el('span', 'parley-when', s.at)); list.append(li); } steps.append(list); }
            const files = el('section', 'parley-files');
            files.append(el('h3', '', said(words, 'files')));
            if (v.files.length === 0) files.append(el('p', 'parley-empty', said(words, 'no-files')));
            else {
                const list = el('ul');
                for (const f of v.files) {
                    const li = el('li'); li.append(el('span', 'parley-name', f.name));
                    const b = fileButton(f); if (b) li.append(' ', b);
                    li.append(el('span', 'parley-path', f.note ? `${f.note} - ${f.path}` : f.path));
                    if (f.open === null) li.dataset.outside = 'true';
                    list.append(li);
                }
                files.append(list);
            }
            aside.replaceChildren(steps, files, ...(terminal ? [button(said(words, 'terminal'), 'parley-terminal', () => terminal())] : []));
        } else aside.replaceChildren();
        if (atBottom) { thread.scrollTop = thread.scrollHeight; requestAnimationFrame(() => { thread.scrollTop = thread.scrollHeight; }); }
    }
    async function refresh() { try { paint(await load()); } catch { /* shown again at the next look */ } }
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = box.value.trim();
        if (!text) return;
        box.value = '';
        void say(text);
    });
    /* With a keyboard, Enter sends and Shift+Enter is a new line, as in every
       chat; on a touch screen Enter is a new line and the button sends. */
    const keyboard = typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
    box.addEventListener('keydown', (event) => { if (keyboard && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    const timer = every > 0 ? setInterval(() => { if (!document.hidden) void refresh(); }, every) : null;
    void refresh();
    return { refresh, get view() { return as; }, set view(v) { if (VIEWS.includes(v)) choose(v); }, destroy() { if (timer) clearInterval(timer); root.replaceChildren(); root.classList.remove('parley'); delete root.dataset.view; } };
}

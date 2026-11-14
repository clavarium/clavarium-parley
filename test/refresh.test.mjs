/* A LOOK THAT COSTS LITTLE: a long thread (2,000 messages, markdown on) looked at again and
   again, by Parley's own clock and by the application's. A look that brings nothing builds
   nothing; one that brings a step or a message builds that row, and the others stay the very
   same nodes -- where the reader is, what is open, what is typed. And the message being sent
   stays in sight, faint, until the thread has it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fakePage } from './fake-dom.mjs';
import { mount } from '../ui/parley-ui.js';
import { texts } from '../host/parley-host.mjs';

/* Nodes are compared with ===: a failed assert.equal on two nodes would print the whole page. */
const settle = () => new Promise((r) => setImmediate(r));
const T0 = Date.parse('2026-01-01T08:00:00.000Z');
const atOf = (k) => new Date(T0 + k * 60_000).toISOString();

/* A host as an application has one: a thread, a cursor that moves with each line, and a
   look "since" a cursor that gives only what came after it. */
function host(n) {
    const messages = [];
    for (let k = 0; k < n; k += 1) {
        const at = atOf(k);
        if (k % 3 === 2) messages.push({ from: 'person', id: `p${k}`, at, text: `Answer number ${k}, with a few words.`, seen: true });
        else messages.push({ from: 'agent', id: `a${k}`, at, kind: 'say', text: `**Point ${k}**: the build went through.\n\n- one item\n- two \`items\`\n\nSee [the page](https://example.com/${k}).` });
    }
    const steps = [];
    const h = { messages, steps, version: 0, changed: new Map(), reads: 0, failNext: false,
        cursor() { return String(h.version); },
        add(m) { h.version += 1; messages.push(m); h.changed.set(m.id, h.version); },
        step(s) { h.version += 1; steps.push({ ...s, v: h.version }); },
        async read(o = {}) {
            h.reads += 1;
            const cursor = h.cursor();
            if (o.since !== undefined) {
                const from = Number(o.since);
                return { since: true, messages: messages.filter((m) => (h.changed.get(m.id) ?? 0) > from), steps: steps.filter((s) => s.v > from).map(({ v, ...s }) => s), cursor };
            }
            return { messages: [...messages], steps: steps.map(({ v, ...s }) => s), cursor, window: { before: null, more: 0, total: messages.length } };
        },
        /* What the box sends: written in the thread (the cursor moves), or refused. */
        async send(text) {
            if (h.failNext) { h.failNext = false; throw new Error('offline'); }
            /* Held: it is written only once let go, as a slow network would. */
            if (h.hold) { h.hold = false; await new Promise((r) => { h.release = r; }); }
            h.add({ from: 'person', id: `s${h.version}`, at: atOf(100_000 + h.version), text, seen: false });
        },
    };
    return h;
}

function page(t) { const leave = fakePage(); const handles = []; t.after(() => { for (const x of handles) x.destroy(); leave(); }); return handles; }
async function mounted(t, h, more = {}) {
    const handles = page(t);
    const root = document.createElement('div'); document.body.append(root);
    const handle = mount(root, { load: (o) => h.read(o), send: (text) => h.send(text), words: texts('en'), every: 0, touch: false, markdown: true, window: { messages: 5000 }, ...more });
    handles.push(handle);
    await settle(); await settle();
    return { root, handle, thread: root.querySelector('.parley-thread') };
}
/* How long a look takes, and what it made: elements created, rows of the thread put in. */
async function measured(thread, look) {
    const before = new Set(thread.childNodes);
    const make = document.createElement; let made = 0;
    document.createElement = (tag) => { made += 1; return make(tag); };
    const t0 = performance.now();
    await look();
    const ms = performance.now() - t0;
    document.createElement = make;
    const replaced = thread.childNodes.filter((n) => !before.has(n)).length;
    return { ms, made, replaced };
}
const best = async (thread, times, prepare, look) => {
    let out = null;
    for (let i = 0; i < times; i += 1) { await prepare(i); const m = await measured(thread, look); if (!out || m.ms < out.ms) out = m; }
    return out;
};

test('2,000 messages: a look that brings nothing, a step, a message -- each costs only what it brings', async (t) => {
    const h = host(2000);
    const { handle, thread } = await mounted(t, h);
    assert.equal(thread.querySelectorAll('.parley-said').length, 2000, 'the whole thread is drawn');
    const nothing = await best(thread, 5, () => {}, () => handle.refresh());
    const doing = await best(thread, 5, (i) => h.step({ id: `d${i}`, at: atOf(2000 + i), kind: 'doing', text: `Running step ${i}` }), () => handle.refresh());
    const message = await best(thread, 5, (i) => h.add({ from: 'agent', id: `n${i}`, at: atOf(2100 + i), kind: 'say', text: `New **message** ${i}.` }), () => handle.refresh());
    const r = (m) => `${m.ms.toFixed(1)} ms, ${m.made} made, ${m.replaced} rows put in`;
    t.diagnostic(`no change: ${r(nothing)}; one doing step: ${r(doing)}; one message: ${r(message)}`);
    assert.equal(thread.querySelectorAll('.parley-said').length, 2005);
    /* Budgets: the old code rebuilt every row (tens of thousands of elements) at each step or message. */
    assert.equal(nothing.made, 0, 'nothing new: nothing built');
    assert.equal(nothing.replaced, 0);
    assert.ok(doing.made < 100, `a step builds its own row only (${doing.made})`);
    assert.ok(doing.replaced <= 3, `a step puts in its own row only (${doing.replaced})`);
    assert.ok(message.made < 200, `a message builds its own rows only (${message.made})`);
    assert.ok(message.replaced <= 4, `a message puts in its own rows only (${message.replaced})`);
    assert.ok(nothing.ms < 20, `a look that brings nothing is quick (${nothing.ms.toFixed(1)} ms)`);
});

const sendOf = (root) => (text) => { const box = root.querySelector('.parley-box'); box.value = text; root.querySelector('.parley-form').requestSubmit(); };
/* The reader went up the thread: what the browser says when they scroll. */
const scrolledUp = (thread, top = 1234) => { thread.scrollHeight = 100_000; thread.clientHeight = 500; thread.scrollTop = top; thread.dispatchEvent({ type: 'scroll', bubbles: false }); };

test('the message being sent stays in sight through every drawing of the thread, until the thread has it; then it is that message, in its place', async (t) => {
    const h = host(300);
    const { root, handle, thread } = await mounted(t, h);
    scrolledUp(thread);
    h.hold = true;
    sendOf(root)('On my way');
    await settle();
    const faint = () => thread.querySelectorAll('.parley-sending');
    assert.equal(faint().length, 1, 'at once, faint');
    assert.ok(thread.childNodes.at(-1).querySelector('.parley-sending') === faint()[0], 'at the end of the thread');
    assert.equal(thread.scrollTop, thread.scrollHeight, 'put in sight, though the reader was further up: they just wrote');
    /* The thread drawn again meanwhile, by steps of the agent, a message, both clocks. */
    for (let i = 0; i < 3; i += 1) {
        h.step({ id: `w${i}`, at: atOf(400 + i), kind: 'doing', text: `Working ${i}` });
        if (i === 1) h.add({ from: 'agent', id: `x${i}`, at: atOf(400 + i), kind: 'say', text: 'Meanwhile.' });
        await handle.refresh();
        assert.equal(faint().length, 1, `still there after drawing ${i}`);
        assert.ok(thread.childNodes.at(-1).querySelector('.parley-sending') === faint()[0], 'still the last');
    }
    h.release();
    for (let i = 0; i < 4; i += 1) await settle();
    assert.equal(faint().length, 0, 'gone once the thread has it');
    const mine = [...thread.querySelectorAll('.parley-said')].filter((b) => b.textContent.includes('On my way'));
    assert.equal(mine.length, 1, 'shown once: the thread\'s own copy');
    assert.ok([...thread.querySelectorAll('.parley-said')].at(-1) === mine[0], 'where the faint one was: the newest message');
});

test('a message that could not be sent says so in its bubble, and is sent again with one tap', async (t) => {
    const h = host(20);
    const { root, thread } = await mounted(t, h);
    h.failNext = true;
    sendOf(root)('Try this');
    for (let i = 0; i < 4; i += 1) await settle();
    const failed = thread.querySelector('.parley-sending[data-state="failed"]');
    assert.ok(failed, 'shown failed');
    assert.match(root.querySelector('.parley-problem').textContent, /offline/, 'the reason, as before');
    assert.equal(root.querySelector('.parley-box').value, 'Try this', 'the words back in the box, as before');
    const again = failed.querySelector('.parley-send-again');
    assert.equal(again.textContent, 'Send again');
    again.click();
    for (let i = 0; i < 4; i += 1) await settle();
    assert.equal(thread.querySelectorAll('.parley-sending').length, 0);
    assert.equal(root.querySelector('.parley-box').value, '', 'sent from the bubble: the box is empty again');
    assert.equal([...thread.querySelectorAll('.parley-said')].filter((b) => b.textContent.includes('Try this')).length, 1);
});

test('a new message leaves every other row the very same node: the reader stays where they read, the focus and what was opened stay', async (t) => {
    const h = host(400);
    const { handle, thread } = await mounted(t, h);
    const before = new Map([...thread.querySelectorAll('.parley-said')].map((b) => [b.dataset.id, b]));
    const rows = [...thread.childNodes];
    scrolledUp(thread, 2222);
    const focused = before.get('a10').querySelector('button'); focused.focus();
    before.get('a19').dataset.mine = 'opened';
    h.add({ from: 'agent', id: 'late', at: atOf(500), kind: 'say', text: 'Late news.' });
    await handle.refresh();
    const after = [...thread.querySelectorAll('.parley-said')];
    assert.equal(after.length, 401);
    /* All but the agent's newest before it, which folds now that it is not the newest any more (#87). */
    const changed = after.filter((b) => before.has(b.dataset.id) && b !== before.get(b.dataset.id)).map((b) => b.dataset.id);
    assert.deepEqual(changed, ['a399'], 'every other message: the same node');
    assert.ok(rows.filter((r) => !r.isConnected).length <= 2, 'at most the row before the new one changed (its fold, its day)');
    assert.equal(thread.scrollTop, 2222, 'reading older messages: where they were');
    assert.ok(document.activeElement === focused, 'the focus where it was');
    assert.equal(before.get('a19').dataset.mine, 'opened', 'what the reader changed on a row, kept');
    /* Two looks asked at once (the application's clock and this one): one more read, not two. */
    const reads = h.reads;
    await Promise.all([handle.refresh(), handle.refresh(), handle.refresh()]);
    assert.equal(h.reads - reads, 2, 'the one running, then one for all who asked meanwhile');
});

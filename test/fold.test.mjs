/* #87: when a newer message of the agent arrives, the one it pushes up does not
 * fold at once -- it keeps its full body with a slow countdown bar, which a tap
 * cancels. No network: the fake page drives two draws via handle.refresh(). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakePage } from './fake-dom.mjs';
import { mount } from '../ui/parley-ui.js';
import { texts } from '../host/parley-host.mjs';

const settle = () => new Promise((r) => setTimeout(r, 5));
const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();

test('a message the newest pushes up gets the folding countdown; a tap keeps it open', async (t) => {
    const leave = fakePage();
    const root = document.createElement('div'); document.body.append(root);
    const messages = [{ from: 'agent', id: 'm', at: at(0), kind: 'say', text: 'First message, long enough to matter.\n\nA second paragraph of it.' }];
    const handle = mount(root, { load: async () => ({ messages: [...messages] }), send: async () => {}, words: texts('en'), every: 0, touch: false, markdown: true });
    t.after(() => { try { handle.destroy(); } catch { /* page already gone */ } leave(); });
    await settle(); await settle();
    /* While it is the newest, it is shown full with no countdown. */
    assert.equal(root.querySelector('.parley-fold'), null, 'no fold bar while it is the newest');
    assert.ok(root.querySelector('.parley-md'), 'its full body is shown');

    /* A newer agent message arrives: the previous one folds -- with the countdown bar. */
    messages.push({ from: 'agent', id: 'n', at: at(1), kind: 'say', text: 'A newer message.' });
    await handle.refresh(); await settle();
    const bar = root.querySelector('.parley-fold');
    assert.ok(bar, 'the pushed-up message shows the folding countdown bar');
    assert.ok(root.querySelector('.parley-fold-fill'), 'with the moving fill (the countdown)');
    assert.ok(root.querySelector('.parley-fold-label').textContent.length > 0, 'and its label');

    /* A tap keeps it open: the bar goes, the message stays full. */
    bar.click();
    await settle();
    assert.equal(root.querySelector('.parley-fold'), null, 'after a tap the bar is gone');
    assert.ok(root.querySelector('.parley-md'), 'the message is still full (kept open)');
});

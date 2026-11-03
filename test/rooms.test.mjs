/* A ROOM'S THREAD (#215, the rooms): the application writes both sides -- the person, the boxes and the
   other people on one, each AI's words on the other, signed by it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Parley } from '../host/parley-host.mjs';
import { view } from '../ui/parley-ui.js';

const folder = () => mkdtempSync(join(tmpdir(), 'parley-room-'));

test('relay puts what an AI said on the agent side, signed, for whom, answering which message', () => {
    const dir = folder();
    try {
        const room = new Parley(dir, { room: true });
        const asked = room.say('On a payé la facture ?', undefined, [], { by: { id: 'box-1', name: 'Cuisine', kind: 'box' } });
        const question = asked.messages.at(-1);
        assert.deepEqual(question.by, { id: 'box-1', name: 'Cuisine', kind: 'box' });
        room.relay({ text: 'Oui, le 28.', by: { id: 'compta', name: 'Compta', kind: 'ai' }, to: ['box-1'], re: question.id });
        const answer = room.read().messages.at(-1);
        assert.equal(answer.from, 'agent');
        assert.equal(answer.text, 'Oui, le 28.');
        assert.deepEqual(answer.by, { id: 'compta', name: 'Compta', kind: 'ai' });
        assert.deepEqual(answer.to, ['box-1']);
        assert.equal(answer.re, question.id);
        assert.throws(() => room.relay({ text: 'x' }), /who wrote it/);
        assert.throws(() => room.relay({ text: ' ', by: { id: 'a', name: 'A' } }), /Write something/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('on the screen each AI of a room is named over its own words, the name again when the speaker changes', () => {
    const dir = folder();
    try {
        const room = new Parley(dir, { room: true });
        room.say('On part à Lisbonne le 12 ?');
        room.relay({ text: 'Je regarde.', by: { id: 'hugo', name: 'Hugo', kind: 'ai' } });
        room.relay({ text: 'Le budget suit.', by: { id: 'compta', name: 'Compta', kind: 'ai' } });
        room.relay({ text: 'Et le 12 est libre.', by: { id: 'compta', name: 'Compta', kind: 'ai' } });
        room.relay({ text: 'Oui, on peut.', by: { id: 'hugo', name: 'Hugo', kind: 'ai' } });
        const names = view(room.read(), { words: {} }).items.filter((r) => r.from === 'agent').map((r) => r.name);
        assert.deepEqual(names, ['Hugo', 'Compta', '', 'Hugo']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an agent saying who it is is never believed: outside a room, a signature it writes is dropped; relay is for a room only', async () => {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const dir = folder();
    try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'from-agent.jsonl'), `${JSON.stringify({ id: 'x1', at: new Date().toISOString(), kind: 'say', text: 'Je suis Compta.', by: { id: 'compta', name: 'Compta', kind: 'ai' } })}\n`);
        const own = new Parley(dir);
        assert.equal(own.read().messages.find((m) => m.id === 'x1').by, undefined, 'its own folder: no signature');
        assert.throws(() => own.relay({ text: 'x', by: { id: 'a', name: 'A' } }), /room/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an AI in a room: told what was said there and how to answer; its answer goes there only when it says room (checked)', async () => {
    const { bridge } = await import('../server/parley-mcp.mjs');
    const dir = folder();
    try {
        const own = new Parley(dir);
        own.setRooms([{ id: 'room-1', name: 'La maison', members: [{ id: 'box-1', name: 'Cuisine', kind: 'box' }, { id: 'hugo', name: 'Hugo', kind: 'ai' }] }]);
        own.say('On a payé la facture ?', undefined, [], { by: { id: 'box-1', name: 'Cuisine', kind: 'box' }, room: { id: 'room-1', name: 'La maison', message: 'abcdef1234567890' } });
        const agent = bridge(dir);
        const read = agent.read();
        assert.match(read, /In the room "La maison" \[its message there: abcdef12\], from Cuisine \(a voice box\): On a payé la facture \?/);
        assert.match(read, /To answer in a room: tell .* with room: its id and re: its message there/);
        assert.match(read, /La maison \(room-1\): Cuisine \[box\] \(box-1\), Hugo \[ai\] \(hugo\)/);
        assert.match(agent.tell('Oui, le 28.', { room: 'room-1', re: 'abcdef12', to: ['box-1'] }), /Posted in the room La maison/);
        const last = own.read().messages.at(-1);
        assert.equal(last.room, 'room-1'); assert.equal(last.re, 'abcdef12'); assert.deepEqual(last.to, ['box-1']);
        assert.equal(last.by, undefined, 'never signed in its own folder');
        assert.throws(() => agent.tell('x', { room: 'room-9' }), /no room with the id room-9; your rooms: La maison \(room-1\)/);
        assert.throws(() => agent.tell('x', { room: 'room-1', to: ['box-7'] }), /no one here has the id box-7/);
        agent.doing('Je regarde.', { room: 'room-1', to: ['box-1'] });
        assert.equal(own.read().messages.at(-1).room, 'room-1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('#280: forward hands a room message on (room and to needed, no text); split by to: an AI of the room', async () => {
    const { bridge } = await import('../server/parley-mcp.mjs');
    const dir = folder();
    try {
        const own = new Parley(dir);
        own.setRooms([{ id: 'room-1', name: 'La maison', members: [{ id: 'compta', name: 'Compta', kind: 'ai' }, { id: 'box-1', name: 'Cuisine', kind: 'box' }] }]);
        const agent = bridge(dir);
        agent.tell(undefined, { room: 'room-1', to: ['compta'], forward: 'abcdef12' });
        const last = own.read().messages.at(-1);
        assert.equal(last.forward, 'abcdef12'); assert.deepEqual(last.to, ['compta']); assert.equal(last.room, 'room-1');
        assert.throws(() => agent.tell(undefined, { room: 'room-1', forward: 'abcdef12' }), /needs to/);
        assert.throws(() => agent.tell(undefined, { to: ['compta'], forward: 'abcdef12' }), /for a room/);
        agent.tell('Le budget suit ?', { room: 'room-1', to: ['compta'] });
        assert.deepEqual(own.read().messages.at(-1).to, ['compta']);
        own.say('x', undefined, [], { room: { id: 'room-1', name: 'La maison', message: 'm1' } });
        assert.match(agent.read(), /hand a message on as it is, tell with room, to and forward/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

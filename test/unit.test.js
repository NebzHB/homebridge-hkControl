'use strict';
const test = require('node:test');
const assert = require('node:assert');
const B = require('../lib/hapBuilder');
const {DaemonClient} = require('../lib/daemonClient');

const silentLog = {debug() {}, info() {}, warn() {}, error() {}};

test('expandUUID : UUID courts HAP et UUID complets', () => {
	assert.strictEqual(B.expandUUID('25'), '00000025-0000-1000-8000-0026BB765291');
	assert.strictEqual(B.expandUUID('3e'), '0000003E-0000-1000-8000-0026BB765291');
	assert.strictEqual(B.expandUUID('e863f10d-079e-48ff-8f27-9c2605a29f52'), 'E863F10D-079E-48FF-8F27-9C2605A29F52');
});

test('charProps : recopie et renommage des métadonnées HAP', () => {
	const props = B.charProps({format: 'uint8', perms: ['pr', 'pw', 'ev', 'xx'], minValue: 0, maxValue: 3, 'valid-values': [0, 1, 3], unit: 'percentage'});
	assert.deepStrictEqual(props, {format: 'uint8', perms: ['pr', 'pw', 'ev'], minValue: 0, maxValue: 3, validValues: [0, 1, 3], unit: 'percentage'});
});

test('exclusions : wr, tlv8 en écriture, services caméra', () => {
	assert.ok(B.skipCharReason({format: 'tlv8', perms: ['pr', 'pw', 'wr']}));
	assert.ok(B.skipCharReason({format: 'tlv8', perms: ['pr', 'pw']}));
	assert.strictEqual(B.skipCharReason({format: 'tlv8', perms: ['pr']}), null);
	assert.strictEqual(B.skipCharReason({format: 'bool', perms: ['pr', 'pw', 'ev', 'tw']}), null);
	assert.ok(B.skipServiceReason({type: '110'}));
	assert.strictEqual(B.skipServiceReason({type: '43'}), null);
});

test('isBridgeInfoOnly : aid 1 d\'un pont ignoré', () => {
	assert.ok(B.isBridgeInfoOnly({aid: 1, services: [{type: '3E'}, {type: 'A2'}]}));
	assert.ok(!B.isBridgeInfoOnly({aid: 2, services: [{type: '3E'}, {type: '43'}]}));
});

test('accessoryName / sanitizeName', () => {
	const acc = {services: [{type: '3E', characteristics: [{type: '23', value: '  Lampe salon (1) ! '}]}]};
	assert.strictEqual(B.sanitizeName(B.accessoryName(acc, 'repli')), 'Lampe salon 1');
	assert.strictEqual(B.accessoryName({services: []}, 'repli'), 'repli');
	assert.strictEqual(B.sanitizeName('***'), 'hkControl');
});

test('SSE : parsing des messages, commentaires et hello', () => {
	const c = new DaemonClient({daemonUrl: 'http://x/api/v1', log: silentLog});
	const events = [];
	let hello = null;
	c.on('event', (e) => events.push(e));
	c.on('connected', (d) => {
		hello = d;
	});
	c.handleSseMessage(': keepalive');
	c.handleSseMessage('id: 1\nevent: hello\ndata: {"apiVersion":1}');
	c.handleSseMessage('id: 2\nevent: updateValue\ndata: {"id":"A","aid":1,"iid":10,"value":1}');
	c.handleSseMessage('event: updateValue\ndata: pas du json');
	assert.deepStrictEqual(hello, {apiVersion: 1});
	assert.deepStrictEqual(events, [{event: 'updateValue', data: {id: 'A', aid: 1, iid: 10, value: 1}}]);
	assert.strictEqual(c.lastEventId, '2');
});

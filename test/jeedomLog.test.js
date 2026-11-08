'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {JeedomLog} = require('../lib/jeedomLog');

const hb = {debug() {}, info() {}, warn() {}, error() {}};
const wait = () => Promise.resolve();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hkc-log-'));

test('dossier des logs Jeedom déduit du stockage Homebridge', () => {
	assert.strictEqual(JeedomLog.logDirFromStorage('/var/www/html/plugins/homebridge/resources/homebridge'), '/var/www/html/log');
});

test('format Jeedom et filtrage par niveau (info : états seulement)', async () => {
	const dir = tmpDir();
	const log = new JeedomLog({hbLog: hb, name: 'hkControl Prise', logDir: dir});
	log.configure({logLevel: 200, logName: 'hkControl_homebridge'});
	log.debug('détail'); log.notice('démarrage'); log.state('Prise > On : 1'); log.warn('attention');
	await wait();
	const lines = fs.readFileSync(path.join(dir, 'hkControl_homebridge'), 'utf8').trim().split('\n');
	assert.strictEqual(lines.length, 2);
	assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]\[INFO\] : \[hkControl Prise\] Prise > On : 1$/);
	assert.match(lines[1], /\[WARNING\] : \[hkControl Prise\] attention$/);
});

test('debug : tout est écrit ; aucun (1000) : rien', async () => {
	const dir = tmpDir();
	const log = new JeedomLog({hbLog: hb, name: 'x', logDir: dir});
	log.configure({logLevel: 100});
	log.debug('a'); log.notice('b'); log.state('c');
	log.configure({logLevel: 1000});
	log.error('d');
	await wait();
	const lines = fs.readFileSync(path.join(dir, 'hkControl_homebridge'), 'utf8').trim().split('\n');
	assert.deepStrictEqual(lines.map((l) => l.split('] ').pop()), ['a', 'b', 'c']);
});

test('nom de log refusé s\'il sort du dossier ; dossier absent : pas de fichier', () => {
	const dir = tmpDir();
	const log = new JeedomLog({hbLog: hb, name: 'x', logDir: dir});
	log.configure({logLevel: 100, logName: '../../etc/passwd'});
	assert.strictEqual(log.file, path.join(dir, 'hkControl_homebridge'));
	const none = new JeedomLog({hbLog: hb, name: 'x', logDir: '/nexiste/pas'});
	assert.strictEqual(none.file, null);
	none.state('rien'); // ne doit pas planter
});

test('en root : le fichier prend le propriétaire du dossier des logs', {skip: (typeof process.getuid !== 'function' || process.getuid() !== 0)}, () => {
	const dir = tmpDir();
	fs.chownSync(dir, 33, 33); // www-data
	const log = new JeedomLog({hbLog: hb, name: 'x', logDir: dir});
	log.state('ligne');
	const st = fs.statSync(path.join(dir, 'hkControl_homebridge'));
	assert.deepStrictEqual([st.uid, st.gid], [33, 33]);
});

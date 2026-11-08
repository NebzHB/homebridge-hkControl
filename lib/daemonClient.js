'use strict';
/**
 * Client de l'API externe v1 du démon hkControl (voir plugin-hkControl docs/api-v1.md).
 *
 * - découverte du port via Jeedom (JSON-RPC getExternalApi, clé API du plugin hkControl)
 * - appels REST (accessories, characteristics GET/PUT)
 * - flux d'événements SSE avec reconnexion
 *
 * Aucune dépendance : fetch natif (Node >= 18).
 */
const {EventEmitter} = require('events');

const SUPPORTED_API_VERSION = 1;
const REQUEST_TIMEOUT_MS = 15000;
const SSE_IDLE_TIMEOUT_MS = 65000; // le démon envoie un keepalive toutes les 20 s
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;

class DaemonError extends Error {
	constructor(message, {httpStatus = null, hapStatus = null} = {}) {
		super(message);
		this.name = 'DaemonError';
		this.httpStatus = httpStatus;
		this.hapStatus = hapStatus;
	}
}

/**
 * @fires DaemonClient#event   ({event, data}) pour chaque événement SSE
 * @fires DaemonClient#connected  quand le flux SSE est ouvert (après « hello »)
 * @fires DaemonClient#disconnected ({error}) quand le flux SSE tombe
 */
class DaemonClient extends EventEmitter {
	/**
	 * @param {object} opts
	 * @param {string} [opts.jeedomUrl] URL Jeedom interne (ex. http://192.168.1.10 ou http://192.168.1.10/jeedom)
	 * @param {string} [opts.apikey] clé API du plugin hkControl
	 * @param {string} [opts.daemonUrl] URL directe de l'API (ex. http://127.0.0.1:55666/api/v1), pour les tests
	 * @param {string} [opts.deviceId] filtre du flux SSE
	 * @param {object} opts.log logger Homebridge
	 */
	constructor({jeedomUrl, apikey, daemonUrl, deviceId, log}) {
		super();
		this.jeedomUrl = (jeedomUrl || '').replace(/\/+$/, '');
		this.apikey = apikey;
		this.fixedDaemonUrl = (daemonUrl || '').replace(/\/+$/, '') || null;
		this.deviceId = deviceId || null;
		this.log = log;
		this.baseUrl = this.fixedDaemonUrl;
		this.stopped = false;
		this.sseAbort = null;
		this.reconnectDelay = RECONNECT_MIN_MS;
		this.reconnectTimer = null;
		this.lastEventId = null;
	}

	/**
	 * Demande à Jeedom le port courant du démon (il change à chaque démarrage).
	 */
	async discover() {
		if (this.fixedDaemonUrl) {
			this.baseUrl = this.fixedDaemonUrl;
			return this.baseUrl;
		}
		if (!this.jeedomUrl || !this.apikey) {
			throw new DaemonError('jeedomUrl et apikey sont requis pour trouver le démon hkControl');
		}
		const body = {
			jsonrpc: '2.0',
			id: Math.floor(Math.random() * 100000),
			method: 'getExternalApi',
			params: {plugin: 'hkControl', apikey: this.apikey},
		};
		const res = await fetchWithTimeout(this.jeedomUrl + '/core/api/jeeApi.php', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify(body),
		});
		const text = await res.text();
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new DaemonError('Réponse Jeedom illisible (clé API hkControl ? plugin hkControl à jour ?) : ' + text.slice(0, 200));
		}
		if (json.error) {
			throw new DaemonError('Jeedom a refusé getExternalApi : ' + (json.error.message || JSON.stringify(json.error)));
		}
		const info = json.result || {};
		if (info.daemonState !== 'ok') {
			throw new DaemonError('Le démon hkControl n\'est pas démarré');
		}
		if (Number(info.apiVersion) !== SUPPORTED_API_VERSION) {
			throw new DaemonError('Version d\'API du démon non supportée : ' + info.apiVersion + ' (attendu ' + SUPPORTED_API_VERSION + '), mettez à jour hkControl et homebridge-hkcontrol');
		}
		const host = new URL(this.jeedomUrl).hostname;
		this.baseUrl = 'http://' + host + ':' + info.port + (info.basePath || '/api/v1');
		return this.baseUrl;
	}

	async request(method, path, body = null) {
		if (!this.baseUrl) {
			await this.discover();
		}
		const opts = {method, headers: {}};
		if (body !== null) {
			opts.headers['Content-Type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		let res;
		try {
			res = await fetchWithTimeout(this.baseUrl + path, opts);
		} catch (e) {
			throw new DaemonError('Démon injoignable : ' + e.message);
		}
		let json;
		try {
			json = await res.json();
		} catch {
			json = null;
		}
		if (!res.ok) {
			throw new DaemonError((json && json.msg) || ('HTTP ' + res.status), {httpStatus: res.status, hapStatus: json && json.hapStatus});
		}
		return json;
	}

	async getInfo() {
		return this.request('GET', '/info');
	}

	async getDevice(id) {
		const r = await this.request('GET', '/accessories?id=' + encodeURIComponent(id));
		return (r && Array.isArray(r.devices) && r.devices[0]) || null;
	}

	/**
	 * @param {string} id
	 * @param {string[]} ids liste "aid.iid"
	 */
	async readCharacteristics(id, ids) {
		const r = await this.request('GET', '/characteristics?id=' + encodeURIComponent(id) + '&ids=' + ids.join(','));
		return (r && r.characteristics) || [];
	}

	/**
	 * @param {string} id
	 * @param {{aid,iid,value}[]} characteristics
	 * @returns {Promise<{aid,iid,status,msg?}[]>}
	 */
	async writeCharacteristics(id, characteristics) {
		const r = await this.request('PUT', '/characteristics', {id, characteristics});
		return (r && r.characteristics) || [];
	}

	/**
	 * Ouvre le flux SSE et le maintient (reconnexion avec backoff, redécouverte du port).
	 */
	start() {
		this.stopped = false;
		this.connectEvents();
	}

	stop() {
		this.stopped = true;
		clearTimeout(this.reconnectTimer);
		if (this.sseAbort) {
			this.sseAbort.abort();
		}
	}

	scheduleReconnect(error) {
		if (this.stopped) {
			return;
		}
		this.emit('disconnected', {error});
		const wait = this.reconnectDelay;
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => this.connectEvents(), wait);
	}

	async connectEvents() {
		if (this.stopped) {
			return;
		}
		const abort = new AbortController();
		this.sseAbort = abort;
		let idleTimer = null;
		const resetIdle = () => {
			clearTimeout(idleTimer);
			idleTimer = setTimeout(() => abort.abort(new Error('flux SSE muet depuis ' + (SSE_IDLE_TIMEOUT_MS / 1000) + ' s')), SSE_IDLE_TIMEOUT_MS);
		};
		try {
			// le port change si le démon a redémarré : on redemande à Jeedom à chaque connexion
			await this.discover();
			const url = this.baseUrl + '/events' + (this.deviceId ? '?id=' + encodeURIComponent(this.deviceId) : '');
			const res = await fetch(url, {headers: {Accept: 'text/event-stream'}, signal: abort.signal});
			if (!res.ok || !res.body) {
				throw new DaemonError('Flux d\'événements refusé : HTTP ' + res.status);
			}
			resetIdle();
			const decoder = new TextDecoder();
			let buffer = '';
			for await (const chunk of res.body) {
				resetIdle();
				buffer += decoder.decode(chunk, {stream: true});
				let sep;
				while ((sep = buffer.indexOf('\n\n')) !== -1) {
					const raw = buffer.slice(0, sep);
					buffer = buffer.slice(sep + 2);
					this.handleSseMessage(raw);
				}
			}
			throw new DaemonError('Flux d\'événements fermé par le démon');
		} catch (e) {
			clearTimeout(idleTimer);
			if (this.stopped) {
				return;
			}
			const reason = (abort.signal.aborted && abort.signal.reason) ? abort.signal.reason : e;
			this.scheduleReconnect(reason);
		}
	}

	handleSseMessage(raw) {
		let event = 'message';
		const dataLines = [];
		for (const line of raw.split('\n')) {
			if (!line || line.startsWith(':')) {
				continue; // commentaire / keepalive
			}
			const idx = line.indexOf(':');
			const field = (idx === -1) ? line : line.slice(0, idx);
			const value = (idx === -1) ? '' : line.slice(idx + 1).replace(/^ /, '');
			if (field === 'event') {
				event = value;
			} else if (field === 'data') {
				dataLines.push(value);
			} else if (field === 'id') {
				this.lastEventId = value;
			}
		}
		if (!dataLines.length) {
			return;
		}
		let data;
		try {
			data = JSON.parse(dataLines.join('\n'));
		} catch {
			this.log.debug('Événement SSE illisible ignoré : ' + raw);
			return;
		}
		if (event === 'hello') {
			this.reconnectDelay = RECONNECT_MIN_MS;
			this.emit('connected', data);
			return;
		}
		this.emit('event', {event, data});
	}
}

async function fetchWithTimeout(url, opts = {}, ms = REQUEST_TIMEOUT_MS) {
	return fetch(url, Object.assign({}, opts, {signal: AbortSignal.timeout(ms)}));
}

module.exports = {DaemonClient, DaemonError, SUPPORTED_API_VERSION};

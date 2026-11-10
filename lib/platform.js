'use strict';
/**
 * Plateforme dynamique « HkControl » : une instance par équipement hkControl exposé
 * (config générée par le plugin Jeedom homebridge, en child bridge).
 *
 * Reconstruit 1:1 les accessoires HomeKit appairés dans hkControl à partir de leur
 * description HAP native, et relaie lecture / écriture / événements via le démon hkControl.
 */
const {DaemonClient} = require('./daemonClient');
const B = require('./hapBuilder');
const {JeedomLog} = require('./jeedomLog');

const PLUGIN_NAME = 'homebridge-hkcontrol';
const PLATFORM_NAME = 'HkControl';
const READ_CHUNK = 50;
const LOG_LEVEL_REFRESH_MS = 2 * 60 * 1000;

// valeurs égales pour HomeKit (booléens reçus en 0/1 ou true/false)
// valeur lisible dans le log Jeedom : booléens en 0/1 comme les commandes binaires Jeedom
const showValue = (binding, v) => ((binding.format === 'bool') ? ((v === true || Number(v) === 1) ? '1' : '0') : JSON.stringify(v));
const sameValue = (a, b) => String((typeof a === 'boolean') ? Number(a) : a) === String((typeof b === 'boolean') ? Number(b) : b);

class HkControlPlatform {
	constructor(log, config, api) {
		this.log = log;
		this.config = config || {};
		this.api = api;
		this.hap = api.hap;
		this.accessories = new Map(); // UUID -> PlatformAccessory (cache + créés)
		this.bindings = new Map(); // "aid.iid" -> liaison caractéristique
		this.online = false;
		this.synced = false;
		this.syncRunning = null;
		this.syncAgain = false;
		this.connectedOnce = false;

		this.hkId = this.config.hkId;
		if (!this.hkId) {
			this.log.error('Paramètre hkId manquant : cette instance ne fait rien (config générée par le plugin Jeedom homebridge).');
			return;
		}

		// log Jeedom hkControl_homebridge, au niveau de log de hkControl (reçu par getExternalApi)
		this.out = new JeedomLog({
			hbLog: this.log,
			name: this.config.name || ('hkControl ' + this.hkId),
			logDir: JeedomLog.logDirFromStorage(this.api.user.storagePath()),
		});

		this.client = new DaemonClient({
			jeedomUrl: this.config.jeedomUrl,
			apikey: this.config.apikey,
			daemonUrl: this.config.daemonUrl,
			deviceId: this.hkId,
			log: this.log,
		});

		this.api.on('didFinishLaunching', () => this.start());
		this.api.on('shutdown', () => {
			clearInterval(this.logLevelTimer);
			this.client.stop();
		});
	}

	/**
	 * Accessoires restaurés du cache : répondent « Pas de réponse » tant que le démon
	 * n'a pas été joint (pas de valeur périmée servie à Maison).
	 */
	configureAccessory(accessory) {
		this.accessories.set(accessory.UUID, accessory);
		const fail = () => {
			throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
		};
		for (const service of accessory.services) {
			if (service.UUID === B.UUID.ACCESSORY_INFORMATION) {
				continue;
			}
			for (const ch of service.characteristics) {
				if (ch.UUID === B.UUID.NAME) {
					continue;
				}
				ch.onGet(fail);
				if (ch.props.perms.includes('pw')) {
					ch.onSet(fail);
				}
			}
		}
	}

	start() {
		this.out.notice('Connexion au démon hkControl pour ' + this.hkId + '...');
		this.client.on('apiInfo', (info) => this.out.configure(info));
		// le niveau de log de hkControl peut changer sans que le démon redémarre : on le redemande régulièrement
		this.logLevelTimer = setInterval(() => {
			if (this.online) {
				this.client.discover().catch((e) => this.out.debug('Relecture du niveau de log impossible : ' + e.message));
			}
		}, LOG_LEVEL_REFRESH_MS);
		this.logLevelTimer.unref();
		this.client.on('connected', () => {
			if (this.connectedOnce) {
				this.out.notice('Reconnecté au démon hkControl');
			}
			this.connectedOnce = true;
			this.resync('connexion au démon');
		});
		this.client.on('disconnected', ({error}) => {
			const msg = (error && error.message) || String(error);
			if (this.online || !this.connectedOnce) {
				this.out.warn('Démon hkControl injoignable (' + msg + '), nouvelle tentative...');
			} else {
				this.out.debug('Démon hkControl toujours injoignable : ' + msg);
			}
			this.setOnline(false);
		});
		this.client.on('event', ({event, data}) => this.handleEvent(event, data));
		this.client.start();
	}

	/**
	 * Relit la description et reconstruit les accessoires (une seule à la fois).
	 */
	resync(reason) {
		if (this.syncRunning) {
			this.syncAgain = true;
			return this.syncRunning;
		}
		this.syncRunning = (async () => {
			do {
				this.syncAgain = false;
				try {
					this.out.debug('Synchronisation (' + reason + ')');
					const device = await this.client.getDevice(this.hkId);
					this.syncAccessories(device);
					this.synced = true;
					this.setOnline(!!device.online);
					await this.refreshValues();
				} catch (e) {
					if (e.httpStatus === 404) {
						this.out.error('L\'équipement ' + this.hkId + ' n\'existe plus dans hkControl (désappairé ?). Accessoires conservés en « Pas de réponse ».');
					} else {
						this.out.warn('Synchronisation impossible : ' + e.message);
					}
					this.setOnline(false);
				}
			} while (this.syncAgain);
			this.syncRunning = null;
		})();
		return this.syncRunning;
	}

	syncAccessories(device) {
		const seen = new Set();
		this.bindings.clear();
		const isBridge = Number(device.category) === 2;
		for (const hapAcc of (device.accessories || [])) {
			const aid = hapAcc.aid;
			if (B.isBridgeInfoOnly(hapAcc)) {
				continue;
			}
			const uuid = this.hap.uuid.generate('hkControl:' + this.hkId + ':' + aid);
			const name = B.sanitizeName(B.accessoryName(hapAcc, device.name));
			let accessory = this.accessories.get(uuid);
			const isNew = !accessory;
			if (isNew) {
				const category = (!isBridge && Number(aid) === 1 && device.category) ? Number(device.category) : undefined;
				accessory = new this.api.platformAccessory(name, uuid, category);
				this.out.notice('Ajout de ' + name + ' (aid ' + aid + ')');
			}
			accessory.context.hk = {hkId: this.hkId, aid};
			this.syncServices(accessory, hapAcc, aid, name);
			if (isNew) {
				this.accessories.set(uuid, accessory);
				this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
			} else {
				this.api.updatePlatformAccessories([accessory]);
			}
			seen.add(uuid);
		}
		for (const [uuid, accessory] of this.accessories) {
			if (!seen.has(uuid)) {
				this.out.notice('Retrait de ' + accessory.displayName + ' (n\'existe plus sur l\'équipement)');
				this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
				this.accessories.delete(uuid);
			}
		}
	}

	syncServices(accessory, hapAcc, aid, name) {
		const {Service, Characteristic} = this.hap;
		const keepServices = new Set();

		// Service d'information : celui de Homebridge, complété avec les infos de l'accessoire
		const infoSvc = accessory.getService(Service.AccessoryInformation);
		const hi = B.infoService(hapAcc);
		if (hi) {
			const set = (charType, uuid) => {
				const v = B.charValue(hi, uuid);
				if (v) {
					infoSvc.setCharacteristic(charType, v);
				}
			};
			set(Characteristic.Manufacturer, B.UUID.MANUFACTURER);
			set(Characteristic.Model, B.UUID.MODEL);
			set(Characteristic.SerialNumber, B.UUID.SERIAL_NUMBER);
			set(Characteristic.FirmwareRevision, B.UUID.FIRMWARE_REVISION);
			infoSvc.setCharacteristic(Characteristic.Name, name);
			const identify = (hi.characteristics || []).find((c) => B.expandUUID(c.type) === B.UUID.IDENTIFY);
			accessory.context.hk.identifyIid = identify ? identify.iid : null;
		}
		if (!accessory.hkIdentifyBound) {
			accessory.hkIdentifyBound = true;
			accessory.on('identify', () => this.identify(accessory));
		}
		keepServices.add(infoSvc);

		const byIid = new Map();
		for (const svc of (hapAcc.services || [])) {
			const svcUUID = B.expandUUID(svc.type);
			if (svcUUID === B.UUID.ACCESSORY_INFORMATION) {
				continue;
			}
			const skip = B.skipServiceReason(svc);
			if (skip) {
				this.out.debug(name + ' : service ' + (svc.typeLabel || svcUUID) + ' ignoré (' + skip + ')');
				continue;
			}
			const usable = [];
			for (const c of (svc.characteristics || [])) {
				const why = B.skipCharReason(c);
				if (why) {
					this.out.debug(name + ' : caractéristique ' + B.charName(c) + ' (' + aid + '.' + c.iid + ') ignorée (' + why + ')');
				} else {
					usable.push(c);
				}
			}
			if (!usable.length) {
				continue;
			}

			const subtype = String(svc.iid);
			const svcName = B.sanitizeName(B.serviceName(svc) || name);
			// pas getServiceById : avec une chaîne, HAP-NodeJS compare le nom du service, pas son UUID
			let service = accessory.services.find((s) => s.UUID === svcUUID && String(s.subtype) === subtype);
			if (!service) {
				service = accessory.addService(new Service(svcName, svcUUID, subtype));
			}
			const keepChars = new Set([B.UUID.NAME]); // Name ajouté par Service() avec le nom du service
			const created = [];
			for (const c of usable) {
				const charUUID = B.expandUUID(c.type);
				const props = B.charProps(c);
				let ch = service.characteristics.find((x) => x.UUID === charUUID);
				try {
					if (ch) {
						ch.setProps(props);
					} else {
						ch = service.addCharacteristic(new Characteristic(B.charName(c), charUUID, props));
					}
				} catch (e) {
					this.out.warn(name + ' : caractéristique ' + B.charName(c) + ' (' + aid + '.' + c.iid + ') non créée : ' + e.message);
					continue;
				}
				keepChars.add(charUUID);
				this.bind(ch, aid, c, name);
				created.push(B.charName(c) + ((c.perms || []).includes('pw') ? ' (rw)' : ''));
			}
			this.out.debug(name + ' : service ' + (svc.typeLabel || svcUUID) + ' (iid ' + svc.iid + ')' + (svc.primary ? ' principal' : '') + (svc.hidden ? ' caché' : '') + ' : ' + created.join(', '));
			for (const ch of [...service.characteristics]) {
				if (!keepChars.has(ch.UUID)) {
					service.removeCharacteristic(ch);
				}
			}
			service.setHiddenService(!!svc.hidden);
			service.setPrimaryService(!!svc.primary);
			keepServices.add(service);
			byIid.set(String(svc.iid), {svc, service});
		}

		// services liés (ex. entrées d'une TV, filtre d'un purificateur)
		for (const {svc, service} of byIid.values()) {
			for (const linkedIid of (Array.isArray(svc.linked) ? svc.linked : [])) {
				const target = byIid.get(String(linkedIid));
				if (target && !service.linkedServices.includes(target.service)) {
					service.addLinkedService(target.service);
				}
			}
		}

		for (const service of [...accessory.services]) {
			if (!keepServices.has(service)) {
				accessory.removeService(service);
			}
		}
	}

	bind(ch, aid, c, accessoryName) {
		const perms = c.perms || [];
		const binding = {
			key: aid + '.' + c.iid,
			label: accessoryName + ' > ' + B.charName(c),
			format: c.format,
			aid,
			iid: c.iid,
			characteristic: ch,
			hasEvents: perms.includes('ev'),
			readable: perms.includes('pr'),
			value: (c.value !== undefined) ? c.value : null,
		};
		this.bindings.set(binding.key, binding);
		if (binding.readable) {
			ch.onGet(() => this.handleGet(binding));
		}
		if (perms.includes('pw')) {
			ch.onSet((value) => this.handleSet(binding, value));
		}
		if (binding.readable && binding.value !== null) {
			this.pushValue(binding, binding.value);
		}
	}

	commFailure() {
		return new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
	}

	async handleGet(binding) {
		if (!this.online) {
			throw this.commFailure();
		}
		// sans événements (pr seul) : lecture directe, repli sur la dernière valeur connue
		if (!binding.hasEvents) {
			try {
				const [r] = await this.client.readCharacteristics(this.hkId, [binding.key]);
				if (r && r.value !== undefined) {
					binding.value = r.value;
				}
			} catch (e) {
				this.out.debug('Lecture de ' + binding.label + ' impossible : ' + e.message);
			}
		}
		if (binding.value === null || binding.value === undefined) {
			throw this.commFailure();
		}
		return binding.value;
	}

	async handleSet(binding, value) {
		if (!this.online) {
			throw this.commFailure();
		}
		let result;
		try {
			[result] = await this.client.writeCharacteristics(this.hkId, [{aid: binding.aid, iid: binding.iid, value}]);
		} catch (e) {
			this.out.warn('Maison → ' + binding.label + ' = ' + JSON.stringify(value) + ' impossible : ' + e.message);
			throw (typeof e.hapStatus === 'number') ? new this.hap.HapStatusError(e.hapStatus) : this.commFailure();
		}
		const status = result ? Number(result.status) : this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
		if (status !== 0) {
			this.out.warn('Maison → ' + binding.label + ' = ' + JSON.stringify(value) + ' refusée par l\'accessoire (statut HAP ' + status + (result && result.msg ? ', ' + result.msg : '') + ')');
			throw new this.hap.HapStatusError(status);
		}
		this.out.debug('Maison → ' + binding.label + ' = ' + showValue(binding, value) + ' : ok');
		if (!sameValue(binding.value, value)) {
			this.out.state(binding.label + ' : ' + showValue(binding, value) + ' (depuis Maison)');
		}
		binding.value = value;
	}

	async identify(accessory) {
		const iid = accessory.context.hk && accessory.context.hk.identifyIid;
		if (!iid || !this.online) {
			return;
		}
		try {
			await this.client.writeCharacteristics(this.hkId, [{aid: accessory.context.hk.aid, iid, value: true}]);
		} catch (e) {
			this.out.debug('Identification impossible : ' + e.message);
		}
	}

	/**
	 * @param {string} [source] 'event' : changement d'état écrit en info ; 'refresh' : relecture, en debug
	 * @returns {boolean} la valeur a changé
	 */
	pushValue(binding, value, source = null) {
		const changed = !sameValue(binding.value, value);
		if (source === 'event') {
			if (changed) {
				this.out.state(binding.label + ' : ' + showValue(binding, value));
			} else {
				this.out.debug(binding.label + ' : ' + showValue(binding, value) + ' (inchangé)');
			}
		} else if (source === 'refresh' && changed) {
			this.out.debug(binding.label + ' : ' + showValue(binding, value) + ' (relu)');
		}
		binding.value = value;
		try {
			binding.characteristic.updateValue(value);
		} catch (e) {
			this.out.debug('Valeur ' + JSON.stringify(value) + ' refusée par HomeKit pour ' + binding.label + ' : ' + e.message);
		}
		return changed;
	}

	handleEvent(event, data) {
		switch (event) {
			case 'updateValue': {
				const binding = this.bindings.get(data.aid + '.' + data.iid);
				if (binding) {
					this.pushValue(binding, data.value, 'event');
				}
				break;
			}
			case 'online':
				this.setOnline(!!data.online);
				if (data.online) {
					this.refreshValues();
				}
				break;
			case 'accessoriesChanged':
			case 'paired':
				this.resync(event);
				break;
			case 'unpaired':
				this.out.warn('L\'équipement a été désappairé dans hkControl');
				this.setOnline(false);
				break;
			default:
				this.out.debug('Événement ignoré : ' + event);
		}
	}

	setOnline(online) {
		if (this.online === online) {
			return;
		}
		this.online = online;
		if (online) {
			if (this.offlineWarned) {
				this.out.state('Équipement de nouveau joignable');
			} else {
				this.out.debug('Équipement joignable');
			}
			this.offlineWarned = false;
			return;
		}
		if (this.synced) {
			this.out.warn('Équipement injoignable : « Pas de réponse » dans Maison');
			this.offlineWarned = true;
		}
		// signale tout de suite l'erreur aux contrôleurs abonnés
		for (const binding of this.bindings.values()) {
			if (binding.hasEvents) {
				try {
					binding.characteristic.updateValue(this.commFailure());
				} catch {
					// ignoré
				}
			}
		}
	}

	/**
	 * Relit toutes les valeurs lisibles (après connexion ou retour en ligne).
	 */
	async refreshValues() {
		if (!this.online) {
			return;
		}
		const keys = [...this.bindings.values()].filter((b) => b.readable).map((b) => b.key);
		let read = 0;
		let changed = 0;
		for (let i = 0; i < keys.length; i += READ_CHUNK) {
			try {
				const values = await this.client.readCharacteristics(this.hkId, keys.slice(i, i + READ_CHUNK));
				for (const r of values) {
					const binding = this.bindings.get(r.aid + '.' + r.iid);
					if (binding && r.value !== undefined) {
						read++;
						changed += this.pushValue(binding, r.value, 'refresh') ? 1 : 0;
					}
				}
			} catch (e) {
				this.out.debug('Relecture des valeurs impossible : ' + e.message);
			}
		}
		this.out.debug('Valeurs relues : ' + read + ', dont ' + changed + ' différente(s) de la dernière connue');
	}
}

module.exports = {HkControlPlatform, PLUGIN_NAME, PLATFORM_NAME};

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

const PLUGIN_NAME = 'homebridge-hkcontrol';
const PLATFORM_NAME = 'HkControl';
const READ_CHUNK = 50;

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

		this.client = new DaemonClient({
			jeedomUrl: this.config.jeedomUrl,
			apikey: this.config.apikey,
			daemonUrl: this.config.daemonUrl,
			deviceId: this.hkId,
			log: this.log,
		});

		this.api.on('didFinishLaunching', () => this.start());
		this.api.on('shutdown', () => this.client.stop());
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
		this.log.info('Connexion au démon hkControl pour ' + this.hkId + '...');
		this.client.on('connected', () => {
			if (this.connectedOnce) {
				this.log.info('Reconnecté au démon hkControl');
			}
			this.connectedOnce = true;
			this.resync('connexion au démon');
		});
		this.client.on('disconnected', ({error}) => {
			const msg = (error && error.message) || String(error);
			if (this.online || !this.connectedOnce) {
				this.log.warn('Démon hkControl injoignable (' + msg + '), nouvelle tentative...');
			} else {
				this.log.debug('Démon hkControl toujours injoignable : ' + msg);
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
					this.log.debug('Synchronisation (' + reason + ')');
					const device = await this.client.getDevice(this.hkId);
					this.syncAccessories(device);
					this.synced = true;
					this.setOnline(!!device.online);
					await this.refreshValues();
				} catch (e) {
					if (e.httpStatus === 404) {
						this.log.error('L\'équipement ' + this.hkId + ' n\'existe plus dans hkControl (désappairé ?). Accessoires conservés en « Pas de réponse ».');
					} else {
						this.log.warn('Synchronisation impossible : ' + e.message);
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
				this.log.info('Ajout de ' + name + ' (aid ' + aid + ')');
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
				this.log.info('Retrait de ' + accessory.displayName + ' (n\'existe plus sur l\'équipement)');
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
				this.log.debug('Service ' + (svc.typeLabel || svcUUID) + ' ignoré : ' + skip);
				continue;
			}
			const usable = [];
			for (const c of (svc.characteristics || [])) {
				const why = B.skipCharReason(c);
				if (why) {
					this.log.debug('Caractéristique ' + B.charName(c) + ' (' + aid + '.' + c.iid + ') ignorée : ' + why);
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
					this.log.warn('Caractéristique ' + B.charName(c) + ' (' + aid + '.' + c.iid + ') non créée : ' + e.message);
					continue;
				}
				keepChars.add(charUUID);
				this.bind(ch, aid, c);
			}
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

	bind(ch, aid, c) {
		const perms = c.perms || [];
		const binding = {
			key: aid + '.' + c.iid,
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
				this.log.debug('Lecture de ' + binding.key + ' impossible : ' + e.message);
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
			this.log.warn('Écriture de ' + binding.key + ' = ' + JSON.stringify(value) + ' impossible : ' + e.message);
			throw (typeof e.hapStatus === 'number') ? new this.hap.HapStatusError(e.hapStatus) : this.commFailure();
		}
		const status = result ? Number(result.status) : this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
		if (status !== 0) {
			this.log.warn('Écriture de ' + binding.key + ' = ' + JSON.stringify(value) + ' refusée (statut HAP ' + status + (result && result.msg ? ', ' + result.msg : '') + ')');
			throw new this.hap.HapStatusError(status);
		}
		this.log.debug('Écriture de ' + binding.key + ' = ' + JSON.stringify(value) + ' : ok');
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
			this.log.debug('Identification impossible : ' + e.message);
		}
	}

	pushValue(binding, value) {
		binding.value = value;
		try {
			binding.characteristic.updateValue(value);
		} catch (e) {
			this.log.debug('Valeur ' + JSON.stringify(value) + ' refusée pour ' + binding.key + ' : ' + e.message);
		}
	}

	handleEvent(event, data) {
		switch (event) {
			case 'updateValue': {
				const binding = this.bindings.get(data.aid + '.' + data.iid);
				if (binding) {
					this.log.debug('Événement ' + binding.key + ' = ' + JSON.stringify(data.value));
					this.pushValue(binding, data.value);
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
				this.log.warn('L\'équipement a été désappairé dans hkControl');
				this.setOnline(false);
				break;
			default:
				this.log.debug('Événement ignoré : ' + event);
		}
	}

	setOnline(online) {
		if (this.online === online) {
			return;
		}
		this.online = online;
		if (online) {
			this.log.info('Équipement joignable');
			return;
		}
		if (this.synced) {
			this.log.warn('Équipement injoignable : « Pas de réponse » dans Maison');
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
		for (let i = 0; i < keys.length; i += READ_CHUNK) {
			try {
				const values = await this.client.readCharacteristics(this.hkId, keys.slice(i, i + READ_CHUNK));
				for (const r of values) {
					const binding = this.bindings.get(r.aid + '.' + r.iid);
					if (binding && r.value !== undefined) {
						this.pushValue(binding, r.value);
					}
				}
			} catch (e) {
				this.log.debug('Relecture des valeurs impossible : ' + e.message);
			}
		}
	}
}

module.exports = {HkControlPlatform, PLUGIN_NAME, PLATFORM_NAME};

'use strict';
/**
 * Log Jeedom de homebridge-hkcontrol (hkControl_homebridge par défaut), au format Jeedom,
 * au niveau de log du plugin hkControl (transmis par getExternalApi).
 *
 * - debug   : actions venues de Maison, changements de statut, détail de la création, connexions
 * - info    : uniquement les états qui changent
 * - warning / error : problèmes, aussi recopiés dans le log Homebridge
 *
 * Plusieurs child bridges écrivent dans le même fichier : une ligne par écriture, en ajout (O_APPEND).
 */
const fs = require('fs');
const path = require('path');

const LEVEL = {DEBUG: 100, INFO: 200, WARNING: 300, ERROR: 400, NONE: 1000};
const DEFAULT_LOG_NAME = 'hkControl_homebridge';

const pad = (n) => String(n).padStart(2, '0');
function timestamp(d = new Date()) {
	return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

class JeedomLog {
	/**
	 * @param {object} opts
	 * @param {object} opts.hbLog logger Homebridge
	 * @param {string} opts.name préfixe des lignes (nom du child bridge)
	 * @param {string} [opts.logDir] dossier des logs Jeedom (déduit du stockage Homebridge du plugin Jeedom homebridge)
	 */
	constructor({hbLog, name, logDir}) {
		this.hbLog = hbLog;
		this.name = name;
		this.level = LEVEL.INFO;
		this.logDir = (logDir && fs.existsSync(logDir)) ? logDir : null;
		this.file = this.logDir ? path.join(this.logDir, DEFAULT_LOG_NAME) : null;
		this.writeErrorLogged = false;
	}

	/**
	 * Dossier des logs Jeedom à partir du stockage Homebridge : <jeedom>/plugins/homebridge/resources/homebridge
	 */
	static logDirFromStorage(storagePath) {
		return path.resolve(storagePath, '..', '..', '..', '..', 'log');
	}

	/**
	 * Niveau et nom du log reçus de hkControl (getExternalApi).
	 */
	configure({logLevel, logName} = {}) {
		const level = Number(logLevel);
		if (Object.values(LEVEL).includes(level)) {
			if (level !== this.level) {
				this.hbLog.debug('Niveau du log ' + (logName || DEFAULT_LOG_NAME) + ' : ' + level);
			}
			this.level = level;
		}
		if (this.logDir && typeof logName === 'string' && /^[A-Za-z0-9_]+$/.test(logName)) {
			this.file = path.join(this.logDir, logName);
		}
	}

	write(levelName, levelValue, msg) {
		if (!this.file || this.level === LEVEL.NONE || levelValue < this.level) {
			return;
		}
		const line = '[' + timestamp() + '][' + levelName + '] : [' + this.name + '] ' + msg + '\n';
		// synchrone : garde l'ordre des lignes (des appendFile asynchrones en parallèle peuvent se croiser)
		try {
			fs.appendFileSync(this.file, line);
			this.fixOwner();
		} catch (err) {
			if (!this.writeErrorLogged) {
				this.writeErrorLogged = true;
				this.hbLog.warn('Écriture impossible dans le log Jeedom ' + this.file + ' : ' + err.message);
			}
		}
	}

	/**
	 * Homebridge tourne en root (sudo hb-service) : le fichier créé appartiendrait à root et Jeedom (www-data)
	 * ne pourrait plus le vider ni le supprimer. On lui donne le propriétaire du dossier des logs Jeedom.
	 */
	fixOwner() {
		if (this.ownerFixedFor === this.file || typeof process.getuid !== 'function' || process.getuid() !== 0) {
			return;
		}
		this.ownerFixedFor = this.file;
		try {
			const dir = fs.statSync(this.logDir);
			const st = fs.statSync(this.file);
			if (st.uid !== dir.uid || st.gid !== dir.gid) {
				fs.chownSync(this.file, dir.uid, dir.gid);
			}
		} catch (e) {
			this.hbLog.debug('Propriétaire du log Jeedom non modifié : ' + e.message);
		}
	}

	/** Détail technique (log Jeedom en debug, log Homebridge en debug). */
	debug(msg) {
		this.write('DEBUG', LEVEL.DEBUG, msg);
		this.hbLog.debug(msg);
	}

	/** Changement d'état d'un accessoire (log Jeedom en info uniquement). */
	state(msg) {
		this.write('INFO', LEVEL.INFO, msg);
	}

	/** Grande étape (démarrage, ajout/retrait d'accessoire) : log Jeedom en debug, log Homebridge en info. */
	notice(msg) {
		this.write('DEBUG', LEVEL.DEBUG, msg);
		this.hbLog.info(msg);
	}

	warn(msg) {
		this.write('WARNING', LEVEL.WARNING, msg);
		this.hbLog.warn(msg);
	}

	error(msg) {
		this.write('ERROR', LEVEL.ERROR, msg);
		this.hbLog.error(msg);
	}
}

module.exports = {JeedomLog, LEVEL, timestamp};
